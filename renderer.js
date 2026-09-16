/**
 * StructureRenderer - 化学構造式描画エンジン
 * smiles-drawer + PubChem API フォールバック
 */
const StructureRenderer = {
    drawer: null,
    smilesDrawerAvailable: false,
    
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
        debug: false
    },

    init() {
        if (typeof SmilesDrawer !== 'undefined' && SmilesDrawer.Drawer) {
            try {
                this.drawer = new SmilesDrawer.Drawer(this.options);
                this.smilesDrawerAvailable = true;
                console.log('smiles-drawer initialized');
            } catch (e) {
                console.warn('smiles-drawer init failed:', e);
            }
        } else {
            console.warn('smiles-drawer not available, using PubChem fallback');
        }
    },

    /**
     * 構造式を描画
     */
    render(container, smiles, theme = 'light', compoundName = '') {
        if (!container) return;
        container.innerHTML = '';

        if (!smiles) {
            this._showFallback(container, compoundName, 'SMILESなし');
            return;
        }

        // 方法1: smiles-drawer
        if (this.smilesDrawerAvailable) {
            try {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('width', '100%');
                svg.setAttribute('height', '100%');
                svg.setAttribute('viewBox', '0 0 300 300');
                svg.style.maxWidth = '100%';
                svg.style.maxHeight = '100%';
                container.appendChild(svg);

                SmilesDrawer.parse(
                    smiles,
                    (tree) => {
                        try {
                            this.drawer.draw(tree, svg, theme, false);
                        } catch (e) {
                            console.warn('smiles-drawer draw failed, trying PubChem');
                            this._renderFromPubChem(container, smiles, compoundName);
                        }
                    },
                    (err) => {
                        console.warn('smiles-drawer parse failed, trying PubChem');
                        this._renderFromPubChem(container, smiles, compoundName);
                    }
                );
                return;
            } catch (e) {
                console.warn('smiles-drawer error:', e);
            }
        }

        // 方法2: PubChem API
        this._renderFromPubChem(container, smiles, compoundName);
    },

    /**
     * PubChem APIからSVGを取得
     */
    _renderFromPubChem(container, smiles, compoundName) {
        const encodedSmiles = encodeURIComponent(smiles);
        const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/${encodedSmiles}/SVG`;

        fetch(url)
            .then(response => {
                if (!response.ok) throw new Error('PubChem API error');
                return response.text();
            })
            .then(svgText => {
                container.innerHTML = svgText;
                const svg = container.querySelector('svg');
                if (svg) {
                    svg.setAttribute('width', '100%');
                    svg.setAttribute('height', '100%');
                    svg.style.maxWidth = '100%';
                    svg.style.maxHeight = '100%';
                }
            })
            .catch(err => {
                console.warn('PubChem fallback failed:', err);
                this._showFallback(container, compoundName, smiles);
            });
    },

    /**
     * フォールバック表示（化合物名+SMILES）
     */
    _showFallback(container, name, smiles) {
        container.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:8px;text-align:center;">
                <div style="font-size:13px;font-weight:bold;color:#333;">${name || '化合物'}</div>
                <div style="font-size:9px;color:#999;margin-top:4px;word-break:break-all;">${smiles || ''}</div>
            </div>
        `;
    }
};

document.addEventListener('DOMContentLoaded', () => {
    StructureRenderer.init();
});




