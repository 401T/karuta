/**
 * StructureRenderer - 化学構造式描画エンジン
 * smiles-drawer v2 対応版
 */
const StructureRenderer = {
    options: {
        width: 300,
        height: 300,
        padding: 20,
        bondThickness: 1.5,
        bondLength: 20,
        bondSpacing: 4,
        atomVisualization: 'default',
        isomeric: true,
        compactDrawing: false,
        fontSizeLarge: 14,
        fontSizeSmall: 10,
        debug: false,
        themes: {
            light: {
                C: '#000000',
                O: '#FF0000',
                N: '#0000FF',
                S: '#FFB000',
                P: '#FF8000',
                F: '#00FF00',
                Cl: '#00FF00',
                Br: '#A52A2A',
                I: '#800080',
                H: '#666666',
                other: '#000000',
                background: '#FFFFFF'
            },
            dark: {
                C: '#FFFFFF',
                O: '#FF6666',
                N: '#6666FF',
                S: '#FFCC00',
                P: '#FF9900',
                F: '#66FF66',
                Cl: '#66FF66',
                Br: '#CC7755',
                I: '#CC66FF',
                H: '#999999',
                other: '#FFFFFF',
                background: '#252A4A'
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
        console.log('StructureRenderer initialized');
        return true;
    },

    /**
     * 構造式を描画
     * @param {HTMLElement} container - 描画先のDOM要素
     * @param {string} smiles - SMILES文字列
     * @param {string} theme - 'light' or 'dark'
     */
    render(container, smiles, theme = 'light') {
        if (!container) {
            console.error('Container is null');
            return;
        }

        if (!smiles || typeof smiles !== 'string') {
            console.error('Invalid SMILES:', smiles);
            container.innerHTML = '<div style="color:red;font-size:10px;text-align:center;">SMILESエラー</div>';
            return;
        }

        // コンテナをクリア
        container.innerHTML = '';

        try {
            // SVG要素を作成
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', '100%');
            svg.setAttribute('height', '100%');
            svg.setAttribute('viewBox', '0 0 300 300');
            svg.style.maxWidth = '100%';
            svg.style.maxHeight = '100%';
            container.appendChild(svg);

            // smiles-drawer v2 の正しい使い方
            const drawer = new SmilesDrawer.Drawer(this.options);
            
            SmilesDrawer.parse(
                smiles,
                (tree) => {
                    try {
                        drawer.draw(tree, svg, theme, false);
                    } catch (drawError) {
                        console.error('Draw error:', drawError, 'SMILES:', smiles);
                        container.innerHTML = `<div style="color:#666;font-size:11px;text-align:center;padding:10px;">描画エラー<br><small>${smiles}</small></div>`;
                    }
                },
                (parseError) => {
                    console.error('Parse error:', parseError, 'SMILES:', smiles);
                    container.innerHTML = `<div style="color:#666;font-size:11px;text-align:center;padding:10px;">SMILES解析エラー<br><small>${smiles}</small></div>`;
                }
            );
        } catch (e) {
            console.error('Render error:', e);
            container.innerHTML = `<div style="color:#666;font-size:11px;text-align:center;padding:10px;">エラー</div>`;
        }
    }
};

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    StructureRenderer.init();
});



