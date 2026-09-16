const StructureRenderer = {
    options: {
        width: 200,
        height: 200,
        padding: 15,
        bondThickness: 1.5,
        bondSpacing: 3.0,
        atomVisualization: 'default',
        isomeric: true,
        compactDrawing: false,
        fontSizeLarge: 15,
        fontSizeSmall: 11,
        debug: false
    },

    init() {
        console.log('StructureRenderer initialized');
    },

    render(container, smiles, theme = 'light') {
        if (!container || !smiles) {
            console.error('Invalid container or SMILES');
            container.innerHTML = '<div style="color:red;font-size:12px;">エラー</div>';
            return;
        }

        container.innerHTML = '';

        try {
            // SVG要素を作成
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("width", "100%");
            svg.setAttribute("height", "100%");
            svg.setAttribute("viewBox", "0 0 200 200");
            svg.style.maxWidth = '100%';
            svg.style.maxHeight = '100%';
            container.appendChild(svg);

            // smiles-drawerで描画
            SmilesDrawer.parse(
                smiles,
                (tree) => {
                    const drawer = new SmilesDrawer.Drawer(this.options);
                    drawer.draw(tree, svg, theme, false);
                },
                (err) => {
                    console.error('SMILES parse error:', err, 'SMILES:', smiles);
                    container.innerHTML = `<div style="color:red;font-size:10px;text-align:center;">${smiles}</div>`;
                }
            );
        } catch (e) {
            console.error('Render error:', e);
            container.innerHTML = `<div style="color:red;font-size:10px;">描画失敗</div>`;
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    StructureRenderer.init();
});

