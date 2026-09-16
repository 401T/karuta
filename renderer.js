/**
 * StructureRenderer - 化学構造式描画エンジン
 * PubChem CIDベースのPNG画像を取得
 */
const StructureRenderer = {
    /**
     * 初期化
     */
    init() {
        console.log('StructureRenderer initialized (PubChem CID mode)');
        return true;
    },

    /**
     * 構造式を描画
     */
    async render(container, smiles, theme = 'light', compoundName = '', formula = '') {
        if (!container) {
            console.error('Container is null');
            return;
        }

        container.innerHTML = '';
        container.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            padding: 8px;
            background: #ffffff;
        `;

        if (!compoundName) {
            this._showFallback(container, '化合物', formula, smiles);
            return;
        }

        try {
            // 1. 化合物名からCIDを取得
            const cid = await this._getCID(compoundName);
            
            if (cid) {
                // 2. CIDでPNG画像を取得
                await this._renderFromCID(container, cid, compoundName);
            } else {
                // CID取得失敗→フォールバック
                this._showFallback(container, compoundName, formula, smiles);
            }
        } catch (e) {
            console.warn('Render failed:', e);
            this._showFallback(container, compoundName, formula, smiles);
        }
    },

    /**
     * 化合物名からPubChem CIDを取得
     */
    async _getCID(name) {
        try {
            const encodedName = encodeURIComponent(name);
            const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodedName}/cids/JSON`;
            
            const response = await fetch(url);
            if (!response.ok) return null;
            
            const data = await response.json();
            return data.IdentifierList?.CID?.[0] || null;
        } catch (e) {
            console.warn('CID fetch failed:', e);
            return null;
        }
    },

    /**
     * CIDからPNG画像を描画
     */
    async _renderFromCID(container, cid, compoundName) {
        return new Promise((resolve) => {
            const imageUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG?image_size=300x300`;
            
            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = compoundName;
            img.style.cssText = `
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
                border-radius: 4px;
            `;

            img.onload = () => {
                container.innerHTML = '';
                container.appendChild(img);
                resolve(true);
            };

            img.onerror = () => {
                resolve(false);
            };
        });
    },

    /**
     * フォールバック表示
     */
    _showFallback(container, name, formula, smiles) {
        container.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:10px;text-align:center;">
                <div style="font-size:16px;font-weight:bold;color:#2c3e50;margin-bottom:8px;">${name}</div>
                ${formula ? `<div style="font-size:12px;color:#34495e;margin-bottom:4px;">${formula}</div>` : ''}
                ${smiles ? `<div style="font-size:9px;color:#7f8c8d;word-break:break-all;max-width:100%;">${smiles}</div>` : ''}
            </div>
        `;
    }
};

document.addEventListener('DOMContentLoaded', () => {
    StructureRenderer.init();
});






