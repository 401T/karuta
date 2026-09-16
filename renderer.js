const StructureRenderer = {
    drawer: null,
    
    init() {
        const options = {
            width: 150,
            height: 150,
            padding: 5,
            bondThickness: 1.2,
            atomVisualization: 'default',
            isomeric: true,
            debug: false
        };
        
        this.drawer = new SmilesDrawer.Drawer(options);
        this.options = options;
    },

    render(container, smiles, theme = 'light') {
        if (!container || !smiles) {
            console.error('Invalid container or SMILES');
            return;
        }

        container.innerHTML = '';
        
        try {
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("width", "100%");
            svg.setAttribute("height", "100%");
            svg.setAttribute("viewBox", "0 0 150 150");
            container.appendChild(svg);
            
            this.drawer.draw(smiles, svg, theme, false);
        } catch (e) {
            console.error(`Render error for ${smiles}:`, e);
            container.innerHTML = `<div style="text-align:center;font-size:10px;">${smiles}</div>`;
        }
    }
};
