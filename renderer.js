/**
 * StructureRenderer - 化学構造式描画エンジン
 * 
 * 【描画戦略】
 * 1. smiles-drawer（ローカル・高速）
 * 2. PubChem API（化合物名→CID→PNG画像）
 * 3. フォールバック（化合物名テキスト表示）
 */
const StructureRenderer = {
    drawer: null,
    smilesDrawerAvailable: false,
    
    // PubChem APIで使えない文字のエスケープ用
    pubchemCache: new Map(),

    /**
     * 初期化
     */
    init() {
        // smiles-drawerの可用性チェック
        if (typeof SmilesDrawer !== 'undefined' && SmilesDrawer.Drawer) {
            try {
                this.drawer = new SmilesDrawer.Drawer({
                    width: 300,
                    height: 300,
                    padding: 20,
                    bondThickness: 1.5,
                    atomVisualization: 'default',
                    isomeric: true,
                    fontSizeLarge: 14,
                    fontSizeSmall: 10
                });
                this.smilesDrawerAvailable = true;
                console.log('✓ smiles-drawer initialized');
            } catch (e) {
                console.warn('smiles-drawer init failed:', e);
            }
        } else {
            console.warn('smiles-drawer not available, will use PubChem API');
        }
        
        return true;
    },

    /**
     * 構造式を描画（メインエントリーポイント）
     * @param {HTMLElement} container - 描画先
     * @param {string} smiles - SMILES文字列
     * @param {string} theme - 'light' or 'dark'
     * @param {Object} compound - 化合物データ {name, name_en, formula, smiles}
     */
    async render(container, smiles, theme = 'light', compound = {}) {
        if (!container) {
            console.error('Container is null');
            return;
        }

        // コンテナ初期化
        container.innerHTML = '';
        container.className = 'card-content';

        const compoundName = compound.name || '';
        const compoundNameEn = compound.name_en || '';
        const formula = compound.formula || '';

        // 方法1: smiles-drawer を試す
        if (this.smilesDrawerAvailable && smiles) {
            const success = await this._renderWithSmilesDrawer(container, smiles, theme);
            if (success) return;
        }

        // 方法2: PubChem API を試す（英語名優先、次に日本語名）
        const nameToTry = compoundNameEn || compoundName;
        if (nameToTry) {
            const success = await this._renderFromPubChem(container, nameToTry, compound);
            if (success) return;
            
            // 英語名で失敗した場合、日本語名でも試す
            if (compoundNameEn && compoundName && compoundNameEn !== compoundName) {
                const success2 = await this._renderFromPubChem(container, compoundName, compound);
                if (success2) return;
            }
        }

        // 方法3: SMILESから直接PubChem APIを試す
        if (smiles) {
            const success = await this._renderFromPubChemSmiles(container, smiles, compound);
            if (success) return;
        }

        // 方法4: フォールバック（化合物名テキスト表示）
        this._showFallback(container, compound);
    },

    /**
     * smiles-drawer で描画
     */
    async _renderWithSmilesDrawer(container, smiles, theme) {
        return new Promise((resolve) => {
            try {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('width', '100%');
                svg.setAttribute('height', '100%');
                svg.setAttribute('viewBox', '0 0 300 300');
                svg.style.maxWidth = '100%';
                svg.style.maxHeight = '100%';
                container.appendChild(svg);

                const timeout = setTimeout(() => {
                    console.warn('smiles-drawer timeout');
                    container.innerHTML = '';
                    resolve(false);
                }, 3000);

                SmilesDrawer.parse(
                    smiles,
                    (tree) => {
                        clearTimeout(timeout);
                        try {
                            this.drawer.draw(tree, svg, theme, false);
                            resolve(true);
                        } catch (e) {
                            console.warn('smiles-drawer draw error:', e);
                            container.innerHTML = '';
                            resolve(false);
                        }
                    },
                    (err) => {
                        clearTimeout(timeout);
                        console.warn('smiles-drawer parse error:', err);
                        container.innerHTML = '';
                        resolve(false);
                    }
                );
            } catch (e) {
                console.warn('smiles-drawer error:', e);
                resolve(false);
            }
        });
    },

    /**
     * PubChem API（化合物名ベース）で描画
     */
    async _renderFromPubChem(container, name, compound) {
        // キャッシュチェック
        const cacheKey = `name:${name}`;
        if (this.pubchemCache.has(cacheKey)) {
            const imgUrl = this.pubchemCache.get(cacheKey);
            return this._loadImage(container, imgUrl, compound);
        }

        try {
            // 化合物名をURLエンコード
            const encodedName = encodeURIComponent(name);
            
            // Step 1: CIDを取得
            const cidUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodedName}/cids/JSON`;
            const cidResponse = await fetch(cidUrl);
            
            if (!cidResponse.ok) {
                console.warn(`PubChem CID fetch failed for: ${name}`);
                return false;
            }
            
            const cidData = await cidResponse.json();
            const cid = cidData?.IdentifierList?.CID?.[0];
            
            if (!cid) {
                console.warn(`No CID found for: ${name}`);
                return false;
            }
            
            // Step 2: PNG画像URLを構築
            const imgUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG?image_size=300x300`;
            
            // キャッシュに保存
            this.pubchemCache.set(cacheKey, imgUrl);
            
            // Step 3: 画像を読み込み
            return await this._loadImage(container, imgUrl, compound);
            
        } catch (e) {
            console.warn(`PubChem name render error for ${name}:`, e);
            return false;
        }
    },

    /**
     * PubChem API（SMILESベース）で描画
     */
    async _renderFromPubChemSmiles(container, smiles, compound) {
        // キャッシュチェック
        const cacheKey = `smiles:${smiles}`;
        if (this.pubchemCache.has(cacheKey)) {
            const imgUrl = this.pubchemCache.get(cacheKey);
            return this._loadImage(container, imgUrl, compound);
        }

        try {
            const encodedSmiles = encodeURIComponent(smiles);
            const imgUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/${encodedSmiles}/PNG?image_size=300x300`;
            
            // 画像が存在するか確認（HEADリクエストの代わりに小さな画像を試す）
            const success = await this._loadImage(container, imgUrl, compound);
            
            if (success) {
                this.pubchemCache.set(cacheKey, imgUrl);
            }
            
            return success;
        } catch (e) {
            console.warn(`PubChem SMILES render error:`, e);
            return false;
        }
    },

    /**
     * 画像を読み込んで表示
     */
    async _loadImage(container, url, compound) {
        return new Promise((resolve) => {
            const img = document.createElement('img');
            img.src = url;
            img.alt = compound?.name || '構造式';
            img.loading = 'lazy';
            img.style.cssText = `
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
                display: block;
            `;

            const timeout = setTimeout(() => {
                console.warn('Image load timeout:', url);
                container.innerHTML = '';
                resolve(false);
            }, 5000);

            img.onload = () => {
                clearTimeout(timeout);
                container.innerHTML = '';
                container.appendChild(img);
                resolve(true);
            };

            img.onerror = () => {
                clearTimeout(timeout);
                container.innerHTML = '';
                resolve(false);
            };
        });
    },

    /**
     * フォールバック表示（化合物名テキスト）
     */
    _showFallback(container, compound) {
        const name = compound?.name || '化合物';
        const formula = compound?.formula || '';
        
        container.innerHTML = `
            <div class="card-fallback">
                <div class="compound-name">${this._escapeHtml(name)}</div>
                ${formula ? `<div class="compound-formula">${this._escapeHtml(formula)}</div>` : ''}
            </div>
        `;
    },

    /**
     * HTMLエスケープ
     */
    _escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    /**
     * キャッシュをクリア
     */
    clearCache() {
        this.pubchemCache.clear();
    }
};

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    StructureRenderer.init();
});







