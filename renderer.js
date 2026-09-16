/**
 * StructureRenderer - 化学構造式描画エンジン
 * smiles-drawer v2 を使用したSVG構造式描画
 */
const StructureRenderer = {
    drawer: null,
    options: {
        width: 200,
        height: 200,
        padding: 12,
        bondThickness: 1.8,
        bondSpacing: 4,
        atomVisualization: 'default',
        isomeric: true,
        compactDrawing: false,
        fontSizeLarge: 16,
        fontSizeSmall: 12,
        debug: false,
        themes: {
            light: {
                C: '#1a1a2e',
                O: '#e63946',
                N: '#457b9d',
                S: '#f4a261',
                P: '#2a9d8f',
                F: '#06d6a0',
                Cl: '#06d6a0',
                Br: '#8d5524',
                I: '#7209b7',
                H: '#6b7280',
                other: '#1a1a2e',
                background: '#ffffff'
            },
            dark: {
                C: '#e8e8e8',
                O: '#ff6b6b',
                N: '#4ecdc4',
                S: '#ffd93d',
                P: '#6bcf7f',
                F: '#4ecdc4',
                Cl: '#4ecdc4',
                Br: '#c77f6b',
                I: '#a78bfa',
                H: '#9ca3af',
                other: '#e8e8e8',
                background: '#252a4a'
            }
        }
    },

    /**
     * 初期化
     */
    init() {
        if (typeof SmilesDrawer === 'undefined') {
            console.error('smiles-drawer library not loaded');
            return false;
        }
        
        try {
            this.drawer = new SmilesDrawer.Drawer(this.options);
            console.log('StructureRenderer initialized successfully');
            return true;
        } catch (e) {
            console.error('Failed to initialize StructureRenderer:', e);
            return false;
        }
    },

    /**
     * 構造式を描画
     * @param {HTMLElement} container - 描画先のDOM要素
     * @param {string} smiles - SMILES文字列
     * @param {string} theme - 'light' or 'dark'
     * @returns {Promise<boolean>} 成功したかどうか
     */
    render(container, smiles, theme = 'light') {
        return new Promise((resolve) => {
            if (!container) {
                console.error('Container is null');
                resolve(false);
                return;
            }

            if (!smiles || typeof smiles !== 'string') {
                console.error('Invalid SMILES:', smiles);
                container.innerHTML = '<div class="structure-error">構造式エラー</div>';
                resolve(false);
                return;
            }

            // コンテナをクリア
            container.innerHTML = '';
            container.classList.add('structure-container');

            try {
                // SVG要素を作成
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('width', '100%');
                svg.setAttribute('height', '100%');
                svg.setAttribute('viewBox', '0 0 200 200');
                svg.style.maxWidth = '100%';
                svg.style.maxHeight = '100%';
                container.appendChild(svg);

                // SMILESをパースして描画
                SmilesDrawer.parse(
                    smiles,
                    (tree) => {
                        try {
                            this.drawer.draw(tree, svg, theme, false);
                            
                            // レスポンシブ対応
                            svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
                            
                            resolve(true);
                        } catch (drawError) {
                            console.error('Draw error:', drawError, 'SMILES:', smiles);
                            container.innerHTML = `<div class="structure-error">描画失敗</div>`;
                            resolve(false);
                        }
                    },
                    (parseError) => {
                        console.error('Parse error:', parseError, 'SMILES:', smiles);
                        container.innerHTML = `<div class="structure-error">SMILESエラー</div>`;
                        resolve(false);
                    }
                );
            } catch (e) {
                console.error('Render error:', e);
                container.innerHTML = `<div class="structure-error">エラー</div>`;
                resolve(false);
            }
        });
    },

    /**
     * 複数の構造式を並列描画
     * @param {Array<{container: HTMLElement, smiles: string}>} items
     * @param {string} theme
     * @returns {Promise<Array<boolean>>}
     */
    async renderMultiple(items, theme = 'light') {
        const promises = items.map(item => 
            this.render(item.container, item.smiles, theme)
        );
        return Promise.all(promises);
    },

    /**
     * SMILES文字列の妥当性をチェック
     * @param {string} smiles
     * @returns {boolean}
     */
    validateSmiles(smiles) {
        if (!smiles || typeof smiles !== 'string') return false;
        
        try {
            SmilesDrawer.parse(
                smiles,
                () => {},
                () => { throw new Error('Invalid SMILES'); }
            );
            return true;
        } catch (e) {
            return false;
        }
    }
};

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    StructureRenderer.init();
});


