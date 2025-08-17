// Chrome 138+ Translation API を使用した翻訳機能（改善版）
// エラーハンドリングとリトライ機能を追加

class ChromeTranslatorV2 {
    constructor() {
        this.translators = new Map();
        this.detector = null;
        this.isAvailable = false;
        this.maxRetries = 3;
        this.retryDelay = 1000; // 1秒
        this.lastTranslationTime = new Map(); // レート制限用
        this.minTranslationInterval = 100; // 最小翻訳間隔（ミリ秒）
        this.checkAvailability();
    }

    // APIの利用可能性をチェック
    async checkAvailability() {
        try {
            // Translation API が利用可能かチェック
            if (!('Translator' in self)) {
                console.log('Chrome Translator API は利用できません（Chrome 138+が必要）');
                this.isAvailable = false;
                return false;
            }

            console.log('Chrome Translator API が利用可能です');
            this.isAvailable = true;
            
            // 言語検出器の初期化も試みる
            if ('LanguageDetector' in self) {
                try {
                    this.detector = await LanguageDetector.create();
                    console.log('言語検出器を初期化しました');
                } catch (error) {
                    console.warn('言語検出器の初期化に失敗（オプション機能）:', error);
                }
            }
            
            return true;
        } catch (error) {
            console.error('Chrome Translation API チェックエラー:', error);
            this.isAvailable = false;
            return false;
        }
    }

    // 言語検出
    async detectLanguage(text) {
        if (!this.detector) {
            console.warn('言語検出器が利用できません');
            return null;
        }
        
        try {
            const detection = await this.detector.detect(text.trim());
            if (detection && detection.length > 0) {
                const { detectedLanguage, confidence } = detection[0];
                console.log(`言語検出: ${detectedLanguage} (信頼度: ${(confidence * 100).toFixed(1)}%)`);
                return detectedLanguage;
            }
            return null;
        } catch (error) {
            console.error('言語検出エラー:', error);
            return null;
        }
    }

    // 翻訳可能性をチェック
    async canTranslate(sourceLang, targetLang) {
        if (!this.isAvailable) {
            return false;
        }
        
        try {
            const availability = await Translator.availability({
                sourceLanguage: sourceLang,
                targetLanguage: targetLang
            });
            
            console.log(`翻訳可能性 (${sourceLang} → ${targetLang}): ${availability}`);
            // 'available' または 'downloadable' の場合は翻訳可能
            return availability === 'available' || availability === 'downloadable';
        } catch (error) {
            console.error(`翻訳可能性チェックエラー (${sourceLang} → ${targetLang}):`, error);
            return false;
        }
    }

    // レート制限チェック
    async waitForRateLimit(key) {
        const lastTime = this.lastTranslationTime.get(key);
        if (lastTime) {
            const elapsed = Date.now() - lastTime;
            if (elapsed < this.minTranslationInterval) {
                const waitTime = this.minTranslationInterval - elapsed;
                console.log(`レート制限: ${waitTime}ms待機`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        this.lastTranslationTime.set(key, Date.now());
    }

    // 翻訳器を作成または取得（リトライ機能付き）
    async getTranslator(sourceLang, targetLang, retryCount = 0) {
        const key = `${sourceLang}_${targetLang}`;
        
        // キャッシュされた翻訳器があれば返す
        if (this.translators.has(key)) {
            const translator = this.translators.get(key);
            // 翻訳器が正常か確認
            try {
                // 簡単なテストで翻訳器の状態を確認
                if (translator && typeof translator.translate === 'function') {
                    return translator;
                }
            } catch (error) {
                console.warn('キャッシュされた翻訳器が無効です。再作成します。');
                this.translators.delete(key);
            }
        }

        try {
            // 翻訳可能性を確認
            const availability = await Translator.availability({
                sourceLanguage: sourceLang,
                targetLanguage: targetLang
            });
            
            if (availability !== 'available' && availability !== 'downloadable') {
                throw new Error(`翻訳不可: ${sourceLang} → ${targetLang} (availability: ${availability})`);
            }
            
            console.log(`Chrome 翻訳器を作成中: ${sourceLang} → ${targetLang}`);
            
            const translator = await Translator.create({
                sourceLanguage: sourceLang,
                targetLanguage: targetLang
            });

            // キャッシュに保存
            this.translators.set(key, translator);
            console.log(`翻訳器作成完了: ${sourceLang} → ${targetLang}`);
            
            return translator;

        } catch (error) {
            console.error(`翻訳器作成エラー (${sourceLang} → ${targetLang}):`, error);
            
            // リトライ
            if (retryCount < this.maxRetries) {
                console.log(`翻訳器作成をリトライします (${retryCount + 1}/${this.maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                return this.getTranslator(sourceLang, targetLang, retryCount + 1);
            }
            
            throw error;
        }
    }

    // テキストを翻訳（リトライ機能付き）
    async translate(text, sourceLang, targetLang, retryCount = 0) {
        if (!this.isAvailable) {
            throw new Error('Chrome Translation API は利用できません');
        }

        if (!text || text.trim() === '') {
            return '';
        }

        const key = `${sourceLang}_${targetLang}`;

        try {
            // レート制限を適用
            await this.waitForRateLimit(key);
            
            // ソース言語が'auto'の場合は言語検出を使用
            if (sourceLang === 'auto' && this.detector) {
                const detected = await this.detectLanguage(text);
                if (detected) {
                    sourceLang = detected;
                    console.log(`言語を自動検出: ${detected}`);
                } else {
                    // 検出できない場合はデフォルトで英語と仮定
                    sourceLang = 'en';
                    console.warn('言語検出失敗、英語と仮定します');
                }
            }
            
            // 同じ言語の場合はそのまま返す
            if (sourceLang === targetLang) {
                return text;
            }
            
            // 翻訳器を取得
            const translator = await this.getTranslator(sourceLang, targetLang);
            
            // 翻訳実行
            const startTime = performance.now();
            const result = await translator.translate(text.trim());
            const endTime = performance.now();
            
            console.log(`翻訳完了 (${Math.round(endTime - startTime)}ms): ${text.substring(0, 50)}... → ${result.substring(0, 50)}...`);
            
            return result;
            
        } catch (error) {
            console.error(`翻訳エラー (リトライ ${retryCount}/${this.maxRetries}):`, error);
            
            // "Other generic failures occurred" エラーの場合はリトライ
            if (error.name === 'UnknownError' && retryCount < this.maxRetries) {
                console.log(`翻訳をリトライします (${retryCount + 1}/${this.maxRetries})`);
                
                // 翻訳器をリセット
                const key = `${sourceLang}_${targetLang}`;
                if (this.translators.has(key)) {
                    const oldTranslator = this.translators.get(key);
                    this.translators.delete(key);
                    // 古い翻訳器をクリーンアップ
                    if (oldTranslator && typeof oldTranslator.destroy === 'function') {
                        try {
                            await oldTranslator.destroy();
                        } catch (e) {
                            console.warn('翻訳器のクリーンアップに失敗:', e);
                        }
                    }
                }
                
                // 待機時間を増やしながらリトライ
                await new Promise(resolve => setTimeout(resolve, this.retryDelay * (retryCount + 1)));
                return this.translate(text, sourceLang, targetLang, retryCount + 1);
            }
            
            throw error;
        }
    }

    // バッチ翻訳（複数のテキストを効率的に翻訳）
    async translateBatch(texts, sourceLang, targetLang) {
        if (!Array.isArray(texts)) {
            texts = [texts];
        }
        
        const results = [];
        const translator = await this.getTranslator(sourceLang, targetLang);
        
        for (const text of texts) {
            try {
                // レート制限を適用
                await this.waitForRateLimit(`${sourceLang}_${targetLang}`);
                const result = await translator.translate(text.trim());
                results.push(result);
            } catch (error) {
                console.error(`バッチ翻訳エラー (${text.substring(0, 30)}...):`, error);
                results.push(text); // エラー時は元のテキストを返す
            }
        }
        
        return results;
    }

    // リソースのクリーンアップ
    async cleanup() {
        // 翻訳器のクリーンアップ
        for (const [key, translator] of this.translators) {
            try {
                if (translator && typeof translator.destroy === 'function') {
                    await translator.destroy();
                }
            } catch (error) {
                console.error(`翻訳器クリーンアップエラー (${key}):`, error);
            }
        }
        this.translators.clear();
        this.lastTranslationTime.clear();
        
        // 言語検出器のクリーンアップ
        if (this.detector && typeof this.detector.destroy === 'function') {
            try {
                await this.detector.destroy();
            } catch (error) {
                console.error('言語検出器クリーンアップエラー:', error);
            }
        }
        this.detector = null;
    }

    // 翻訳器の状態をリセット（エラー回復用）
    async resetTranslator(sourceLang, targetLang) {
        const key = `${sourceLang}_${targetLang}`;
        
        if (this.translators.has(key)) {
            const translator = this.translators.get(key);
            this.translators.delete(key);
            
            if (translator && typeof translator.destroy === 'function') {
                try {
                    await translator.destroy();
                } catch (error) {
                    console.warn('翻訳器のリセット中にエラー:', error);
                }
            }
        }
        
        console.log(`翻訳器をリセットしました: ${sourceLang} → ${targetLang}`);
    }

    // 言語コードを正規化（jimakuChanの形式からChrome Translation APIの形式へ）
    normalizeLanguageCode(code) {
        const mapping = {
            'ja': 'ja',
            'ja-JP': 'ja',
            'en': 'en',
            'en-US': 'en',
            'ko': 'ko',
            'ko-KR': 'ko',
            'zh-CN': 'zh',       // 中国語簡体字
            'zh-TW': 'zh-Hant',  // 中国語繁体字
            'zh-HK': 'zh-Hant',  // 香港語（繁体字として扱う）
            'fr': 'fr',
            'fr-FR': 'fr',
            'it': 'it',
            'it-IT': 'it',
            'de': 'de',
            'de-DE': 'de',
            'tr': 'tr',
            'tr-TR': 'tr',
            'sv': 'sv',
            'sv-SE': 'sv',
            'pl': 'pl',
            'pl-PL': 'pl',
            'uk': 'uk',
            'uk-UA': 'uk',
            'ru': 'ru',
            'ru-RU': 'ru',
            'es': 'es',
            'es-ES': 'es',
            'pt': 'pt',
            'pt-PT': 'pt',
            'pt-BR': 'pt',
            'nl': 'nl',
            'nl-NL': 'nl',
            'id': 'id',
            'id-ID': 'id',
            'vi': 'vi',
            'vi-VN': 'vi',
            'th': 'th',
            'th-TH': 'th',
            'ar': 'ar',
            'ar-SA': 'ar',
            'so': 'so',
            'so-SO': 'so',
            'el': 'el',
            'el-GR': 'el'
        };
        
        return mapping[code] || code;
    }
}

// グローバルインスタンスを作成（既存のインスタンスがあれば置き換え）
if (window.chromeTranslator) {
    // 既存のインスタンスをクリーンアップ
    window.chromeTranslator.cleanup().catch(e => console.warn('既存の翻訳器のクリーンアップに失敗:', e));
}
window.chromeTranslator = new ChromeTranslatorV2();