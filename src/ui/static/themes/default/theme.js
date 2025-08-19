// Sistema de tema padrão
class DefaultTheme {
    constructor() {
        this.name = 'default';
        this.displayName = 'Padrão';
    }
    
    apply() {
        document.body.className = 'theme-default';
        console.log('Tema padrão aplicado');
    }
    
    remove() {
        document.body.classList.remove('theme-default');
    }
}

if (typeof window !== 'undefined') {
    window.DefaultTheme = DefaultTheme;
}

class DefaultTheme {
    constructor() {
        this.init();
    }

    init() {
        this.injectMarkup();
        this.addEventListeners();
    }

    injectMarkup() {
        document.getElementById('sidebar-header').innerHTML = '<h2>Fotos</h2>';
        document.getElementById('main-header').innerHTML = '<h1>Selecione uma Foto</h1>';
    }

    addEventListeners() {
        // Implementação básica de eventos
        document.addEventListener('kiosk:loading:start', () => this.showLoading(true));
        document.addEventListener('kiosk:loading:end', () => this.showLoading(false));
    }

    showLoading(show) {
        const loadingEl = document.getElementById('loading-indicator-placeholder');
        if (loadingEl) {
            loadingEl.innerHTML = show ? '<div class="loading">Carregando...</div>' : '';
        }
    }
}

new DefaultTheme();