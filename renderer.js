/**
 * 化学構造式描画エンジン
 * smiles-drawerライブラリのラッパー
 */
const StructureRenderer = {
    drawer: null,
    
    /**
     * 初期化
     */
    init() {
        // smiles-drawerのオプション設定
        // モバイルで見やすくするため、やや大きめの設定にする
        const options = {
            width: 200,
            height: 200,
            padding: 10,
            bondThickness: 1.5,
            bondSpacing: 3.0,
            atomVisualization: 'default',
            isomeric: true,
            compactDrawing: false,
            fontSizeLarge: 14,
            fontSizeSmall: 10,
            debug: false,
            // カラースキーム（視認性の高いダークモード向け調整も可能だが、
            // ここでは標準的な白背景に黒骨格をベースにする）
            themes: {
                dark: {
                    C: '#ffffff',
                    O: '#ff5252',
                    N: '#4cc9f0',
                    S: '#ffd166',
                    P: '#ff9e7d',
                    F: '#06d6a0',
                    Cl: '#06d6a0',
                    Br: '#a06a4c',
                    I: '#9d4edd',
                    H: '#ffffff',
                    other: '#ffffff',
                    background: '#1e1e28' // カード背景色に合わせる
                },
                light: {
                    C: '#000000',
                    O: '#d10000',
                    N: '#0055ff',
                    S: '#b58000',
                    P: '#ff8000',
                    F: '#00aa00',
                    Cl: '#00aa00',
                    Br: '#a06a4c',
                    I: '#9d4edd',
                    H: '#000000',
                    other: '#000000',
                    background: '#ffffff'
                }
            }
        };

        // 現在のテーマ（CSS変数から取得するか、デフォルトlight）
        // 簡易化のため、ここでは 'light' モード（白背景に黒文字）をデフォルトとする
        // カード背景が白だからである
        this.drawer = new SmilesDrawer.Parser();
        this.options = options;
    },

    /**
     * 構造式を描画する
     * @param {HTMLElement} container - 描画先のDOM要素
     * @param {string} smiles - SMILES文字列
     * @param {string} theme - 'light' or 'dark'
     */
    render(container, smiles, theme = 'light') {
        if (!container || !smiles) return;

        // コンテナをクリア
        container.innerHTML = '';

        try {
            // SMILESをパース
            const tree = SmilesDrawer.parse(smiles, (data) => {
                // 描画設定
                const drawOpts = this.options;
                drawOpts.theme = theme;
                
                // SVG要素を作成
                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                container.appendChild(svg);

                // 描画実行
                const smilesDrawer = new SmilesDrawer.Drawer(drawOpts);
                smilesDrawer.draw(data, svg, theme, false);
                
                // レスポンシブ対応
                svg.style.width = '100%';
                svg.style.height = '100%';
                svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

            }, (err) => {
                console.error("SMILES Parse Error:", err);
                container.innerText = "構造式エラー";
            });
        } catch (e) {
            console.error("Render Error:", e);
            container.innerText = "描画失敗";
        }
    }
};

// 初期化実行
document.addEventListener('DOMContentLoaded', () => {
    StructureRenderer.init();
});
