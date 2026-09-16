/**
 * StructureRenderer - 化学構造式描画エンジン
 * 描画キュー管理 + PubChem API + フォールバック
 */
const StructureRenderer = {
    pubchemCache: new Map(),
    renderQueue: [],
    isRendering: false,
    MAX_CONCURRENT: 2, // 同時リクエスト数
    currentConcurrent: 0,

    init() {
        console.log('StructureRenderer initialized (queued PubChem mode)');
        return true;
    },

    /**
     * 構造式を描画（キュー経由）
     */
    async render(container, smiles, theme = 'light', compound = {}) {
        if (!container) return;

        // ローディング表示
        container.innerHTML = `
            <div class="card-loading">
                <div class="loading-spinner"></div>
                <div class="loading-text">読込中...</div>
            </div>
        `;
        container.className = 'card-content';

        // キューに追加して順次処理
        this.renderQueue.push({ container, smiles, theme, compound });
        this._processQueue();
    },

    /**
     * キューを処理
     */
    async _processQueue() {
        if (this.isRendering) return;
        if (this.renderQueue.length === 0) return;
        if (this.currentConcurrent >= this.MAX_CONCURRENT) return;

        this.isRendering = true;
        const item = this.renderQueue.shift();
        this.currentConcurrent++;

        try {
            await this._renderItem(item);
        } catch (e) {
            console.warn('Render item error:', e);
            this._showFallback(item.container, item.compound);
        } finally {
            this.currentConcurrent--;
            this.isRendering = false;
            // 次のアイテムを処理
            setTimeout(() => this._processQueue(), 100);
        }
    },

    /**
     * 1アイテムを描画
     */
    async _renderItem({ container, smiles, compound }) {
        const nameEn = compound?.name_en || '';
        const name = compound?.name || '';

        // キャッシュチェック
        const cacheKey = nameEn || name || smiles;
        if (this.pubchemCache.has(cacheKey)) {
            const imgUrl = this.pubchemCache.get(cacheKey);
            const success = await this._loadImage(container, imgUrl, compound);
            if (success) return;
        }

        // 方法1: 英語名でPubChem API
        if (nameEn) {
            const success = await this._tryPubChemName(container, nameEn, compound, cacheKey);
            if (success) return;
        }

        // 方法2: 日本語名でPubChem API
        if (name && name !== nameEn) {
            const success = await this._tryPubChemName(container, name, compound, cacheKey);
            if (success) return;
        }

        // 方法3: SMILESでPubChem API
        if (smiles) {
            const success = await this._tryPubChemSmiles(container, smiles, compound, cacheKey);
            if (success) return;
        }

        // フォールバック
        this._showFallback(container, compound);
    },

    /**
     * PubChem API（化合物名）
     */
    async _tryPubChemName(container, name, compound, cacheKey) {
        try {
            const encodedName = encodeURIComponent(name);
            const cidUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodedName}/cids/JSON`;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const cidResponse = await fetch(cidUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (!cidResponse.ok) return false;
            
            const cidData = await cidResponse.json();
            const cid = cidData?.IdentifierList?.CID?.[0];
            if (!cid) return false;
            
            const imgUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG?image_size=300x300`;
            this.pubchemCache.set(cacheKey, imgUrl);
            
            return await this._loadImage(container, imgUrl, compound);
        } catch (e) {
            console.warn(`PubChem name failed for ${name}:`, e.message);
            return false;
        }
    },

    /**
     * PubChem API（SMILES）
     */
    async _tryPubChemSmiles(container, smiles, compound, cacheKey) {
        try {
            const encodedSmiles = encodeURIComponent(smiles);
            const imgUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/${encodedSmiles}/PNG?image_size=300x300`;
            
            const success = await this._loadImage(container, imgUrl, compound);
            if (success) {
                this.pubchemCache.set(cacheKey, imgUrl);
            }
            return success;
        } catch (e) {
            console.warn('PubChem SMILES failed:', e.message);
            return false;
        }
    },

    /**
     * 画像を読み込み
     */
    async _loadImage(container, url, compound) {
        return new Promise((resolve) => {
            const img = document.createElement('img');
            img.src = url;
            img.alt = compound?.name || '構造式';
            img.style.cssText = `
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
                display: block;
            `;

            const timeout = setTimeout(() => {
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
     * フォールバック表示
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

    _escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    clearCache() {
        this.pubchemCache.clear();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    StructureRenderer.init();
});








