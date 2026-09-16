/**
 * StructureRenderer - 化学構造式表示エンジン
 * 化合物名 + 分子式 + SMILES を表示（100%確実）
 */
const StructureRenderer = {
    /**
     * 初期化
     */
    init() {
        console.log('StructureRenderer initialized (Text mode)');
        return true;
    },

    /**
     * 化合物情報を表示
     * @param {HTMLElement} container - 表示先のDOM要素
     * @param {string} smiles - SMILES文字列（参考表示）
     * @param {string} theme - 無視
     * @param {string} compoundName - 化合物名
     * @param {string} formula - 分子式
     */
    render(container, smiles, theme = 'light', compoundName = '', formula = '') {
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
            text-align: center;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            border-radius: 8px;
        `;

        // 化合物名（大きく）
        const nameDiv = document.createElement('div');
        nameDiv.style.cssText = `
            font-size: 14px;
            font-weight: bold;
            color: #2c3e50;
            margin-bottom: 6px;
            line-height: 1.3;
        `;
        nameDiv.textContent = compoundName || '化合物';
        container.appendChild(nameDiv);

        // 分子式（中くらい）
        if (formula) {
            const formulaDiv = document.createElement('div');
            formulaDiv.style.cssText = `
                font-size: 12px;
                color: #34495e;
                margin-bottom: 4px;
                font-family: 'Courier New', monospace;
            `;
            formulaDiv.textContent = formula;
            container.appendChild(formulaDiv);
        }

        // SMILES文字列（小さく）
        if (smiles) {
            const smilesDiv = document.createElement('div');
            smilesDiv.style.cssText = `
                font-size: 8px;
                color: #7f8c8d;
                word-break: break-all;
                max-width: 100%;
                margin-top: 4px;
            `;
            smilesDiv.textContent = smiles;
            container.appendChild(smilesDiv);
        }
    }
};

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    StructureRenderer.init();
});





