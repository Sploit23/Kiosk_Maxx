// THEME.JS (Christmas) - Lógica de animações e interações visuais do tema.

class ChristmasTheme {
    constructor() {
        this.init();
    }

    init() {
        this.injectMarkup();
        this.initWelcomeScreen();
        this.addEventListeners();
    }

    // Insere o HTML específico do tema nos placeholders
    injectMarkup() {
        document.getElementById('sidebar-header').innerHTML = '<h2>🎄 Fotos Mágicas 🎅</h2>';
        document.getElementById('main-header').innerHTML = '<h1>Suas Lembranças de Natal</h1>';
        document.getElementById('welcome-screen-placeholder').innerHTML = `
            <div class="welcome-screen" id="welcome-screen">
                <div class="welcome-santa">🎅</div>
                <h1 class="welcome-title">Ho Ho Ho!</h1>
                <p>Clique para começar</p>
            </div>
        `;
        document.getElementById('loading-indicator-placeholder').innerHTML = `
            <div class="loading-indicator" style="display: none;">
                <div class="spinner"></div>
            </div>
        `;
    }

    initWelcomeScreen() {
        const welcomeScreen = document.getElementById('welcome-screen');
        if (welcomeScreen) {
            const hide = () => {
                welcomeScreen.classList.add('hidden');
                setTimeout(() => welcomeScreen.style.display = 'none', 1000);
            };
            welcomeScreen.addEventListener('click', hide);
            setTimeout(hide, 10000); // Esconde automaticamente após 10s
        }
    }

    // Função createSnowflakes removida para melhor visualização das imagens

    addEventListeners() {
        // Exemplo: Pode ouvir eventos do app.js para animações específicas, se necessário.
    }
}

// Exporta uma instância para que o app.js possa chamá-lo
export const christmasTheme = new ChristmasTheme();