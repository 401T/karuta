/**
 * StructureRenderer - 化学構造式描画エンジン
 * Promise対応版（全カード読み込み完了待機用）
 */
const StructureRenderer = {
    pubchemCache: new Map(),
    renderQueue: [],
    isRendering: false,
    MAX_CONCURRENT: 2,
    currentConcurrent: 0,

    init() {
        console.log('StructureRenderer initialized');
        return true;
    },

    /**
     * 構造式を描画（Promiseを返す）
     * @returns {Promise<boolean>} 成功したかどうか
     */
    render(container, smiles, theme = 'light', compound = {}) {
        return new Promise((resolve) => {
            if (!container) {
                resolve(false);
                return;
            }

            // ローディング表示
            container.innerHTML = `
                <div class="card-loading">
                    <div class="loading-spinner"></div>
                    <div class="loading-text">読込中...</div>
                </div>
            `;
            container.className = 'card-content';

            // キューに追加
            this.renderQueue.push({ container, smiles, theme, compound, resolve });
            this._processQueue();
        });
    },

    async _processQueue() {
        if (this.isRendering) return;
        if (this.renderQueue.length === 0) return;
        if (this.currentConcurrent >= this.MAX_CONCURRENT) return;

        this.isRendering = true;
        const item = this.renderQueue.shift();
        this.currentConcurrent++;

        try {
            const success = await this._renderItem(item);
            item.resolve(success);
        } catch (e) {
            console.warn('Render error:', e);
            this._showFallback(item.container, item.compound);
            item.resolve(false);
        } finally {
            this.currentConcurrent--;
            this.isRendering = false;
            setTimeout(() => this._processQueue(), 50);
        }
    },

    async _renderItem({ container, smiles, compound }) {
        const nameEn = compound?.name_en || '';
        const name = compound?.name || '';
        const cacheKey = nameEn || name || smiles;

        // キャッシュチェック
        if (this.pubchemCache.has(cacheKey)) {
            const imgUrl = this.pubchemCache.get(cacheKey);
            const success = await this._loadImage(container, imgUrl, compound);
            if (success) return true;
        }

        // 方法1: 英語名でPubChem API
        if (nameEn) {
            const success = await this._tryPubChemName(container, nameEn, compound, cacheKey);
            if (success) return true;
        }

        // 方法2: 日本語名でPubChem API
        if (name && name !== nameEn) {
            const success = await this._tryPubChemName(container, name, compound, cacheKey);
            if (success) return true;
        }

        // 方法3: SMILESでPubChem API
        if (smiles) {
            const success = await this._tryPubChemSmiles(container, smiles, compound, cacheKey);
            if (success) return true;
        }

        // フォールバック
        this._showFallback(container, compound);
        return true; // フォールバック表示も「完了」とみなす
    },

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
            }, 8000);

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









