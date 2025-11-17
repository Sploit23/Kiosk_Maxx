// Gerenciador do Resumo da Impressora
class PrinterSummaryManager {
    constructor() {
        this.config = null;
        this.summaryElement = null;
        this.init();
    }

    async init() {
        console.log('🖨️ Inicializando resumo da impressora...');
        
        // Aguardar o DOM estar pronto
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setup());
        } else {
            this.setup();
        }
    }

    async setup() {
        this.summaryElement = document.getElementById('printer-summary');
        if (!this.summaryElement) {
            console.warn('⚠️ Elemento printer-summary não encontrado');
            return;
        }

        // Carregar configurações iniciais
        await this.loadPrinterConfig();
        
        // Atualizar display
        this.updateSummaryDisplay();
        
        // Configurar listeners para mudanças
        this.setupEventListeners();
        
        // Atualizar periodicamente
        setInterval(() => this.loadPrinterConfig(), 30000); // A cada 30 segundos
    }

    async loadPrinterConfig() {
        try {
            const response = await fetch('/api/printer-config');
            if (response.ok) {
                this.config = await response.json();
                this.updateSummaryDisplay();
            } else {
                console.warn('⚠️ Não foi possível carregar configurações da impressora');
                this.showDefaultConfig();
            }
        } catch (error) {
            console.error('❌ Erro ao carregar configurações:', error);
            this.showDefaultConfig();
        }
    }

    updateSummaryDisplay() {
        if (!this.config || !this.summaryElement) return;

        // Atualizar impressora atual
        const currentPrinterElement = document.getElementById('current-printer');
        if (currentPrinterElement) {
            const currentPrinter = this.config.last_used_printer || 'Não configurada';
            currentPrinterElement.textContent = currentPrinter;
            currentPrinterElement.title = `Impressora padrão: ${currentPrinter}`;
        }

        // Atualizar mapeamentos de formato
        const formats = ['10x15', '15x20', 'bolas'];
        formats.forEach(format => {
            const element = document.getElementById(`printer-${format}`);
            if (element) {
                const mapping = this.config.format_mappings?.[format];
                if (mapping && mapping.printer) {
                    element.textContent = mapping.printer;
                    element.title = `Impressora para ${format}: ${mapping.printer}`;
                    element.style.color = 'var(--christmas-red)';
                } else {
                    element.textContent = 'Não configurada';
                    element.title = `Formato ${format} não configurado`;
                    element.style.color = '#6c757d';
                }
            }
        });

        // Atualizar últimas preferências do cliente
        this.updateLastPreferences();

        // Adicionar indicador de status
        this.updateStatusIndicator();
    }

    updateLastPreferences() {
        if (!this.config || !this.config.user_preferences) {
            this.showDefaultPreferences();
            return;
        }

        const prefs = this.config.user_preferences;

        // Atualizar último formato usado
        const lastFormatElement = document.getElementById('last-format');
        if (lastFormatElement) {
            const format = prefs.last_format_used || 'Não definido';
            lastFormatElement.textContent = format.toUpperCase();
            lastFormatElement.title = `Último formato escolhido: ${format}`;
        }

        // Atualizar última impressora usada
        const lastPrinterElement = document.getElementById('last-printer');
        if (lastPrinterElement) {
            const printer = prefs.last_printer_used || 'Não definida';
            lastPrinterElement.textContent = printer;
            lastPrinterElement.title = `Última impressora utilizada: ${printer}`;
        }

        // Atualizar último tamanho de papel
        const lastPaperElement = document.getElementById('last-paper');
        if (lastPaperElement) {
            const paper = prefs.last_paper_size || 'Não definido';
            lastPaperElement.textContent = paper;
            lastPaperElement.title = `Último tamanho de papel: ${paper}`;
        }

        // Atualizar data da última sessão
        const lastDateElement = document.getElementById('last-session-date');
        if (lastDateElement) {
            const date = prefs.last_session_date;
            if (date) {
                const formattedDate = new Date(date).toLocaleString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                lastDateElement.textContent = formattedDate;
                lastDateElement.title = `Última sessão: ${formattedDate}`;
            } else {
                lastDateElement.textContent = 'Não registrada';
                lastDateElement.title = 'Data da última sessão não disponível';
            }
        }
    }

    showDefaultPreferences() {
        const elements = {
            'last-format': 'Não definido',
            'last-printer': 'Não definida',
            'last-paper': 'Não definido',
            'last-session-date': 'Não registrada'
        };

        Object.entries(elements).forEach(([id, defaultText]) => {
            const element = document.getElementById(id);
            if (element) {
                element.textContent = defaultText;
                element.style.color = '#6c757d';
            }
        });
    }

    updateStatusIndicator() {
        const summaryHeader = this.summaryElement.querySelector('.summary-header h3');
        if (!summaryHeader) return;

        // Verificar se há configurações válidas
        const hasValidConfig = this.config && 
            this.config.format_mappings && 
            Object.keys(this.config.format_mappings).length > 0;

        if (hasValidConfig) {
            summaryHeader.innerHTML = '🖨️ Resumo da Impressora ✅';
            this.summaryElement.style.borderColor = 'var(--christmas-green)';
        } else {
            summaryHeader.innerHTML = '🖨️ Resumo da Impressora ⚠️';
            this.summaryElement.style.borderColor = '#ffc107';
        }
    }

    showDefaultConfig() {
        const currentPrinterElement = document.getElementById('current-printer');
        if (currentPrinterElement) {
            currentPrinterElement.textContent = 'Não configurada';
            currentPrinterElement.style.color = '#6c757d';
        }

        const formats = ['10x15', '15x20', 'bolas'];
        formats.forEach(format => {
            const element = document.getElementById(`printer-${format}`);
            if (element) {
                element.textContent = 'Não configurada';
                element.style.color = '#6c757d';
            }
        });

        // Atualizar header para mostrar problema
        const summaryHeader = this.summaryElement?.querySelector('.summary-header h3');
        if (summaryHeader) {
            summaryHeader.innerHTML = '🖨️ Resumo da Impressora ❌';
            this.summaryElement.style.borderColor = '#dc3545';
        }
    }

    setupEventListeners() {
        // Escutar mudanças nas configurações
        window.addEventListener('printerConfigChanged', () => {
            console.log('📡 Configuração da impressora alterada, recarregando...');
            this.loadPrinterConfig();
        });

        // Escutar cliques no resumo para abrir configurações
        if (this.summaryElement) {
            this.summaryElement.addEventListener('click', () => {
                if (confirm('Deseja abrir as configurações da impressora?')) {
                    window.location.href = '/config.html';
                }
            });
            
            // Adicionar cursor pointer para indicar que é clicável
            this.summaryElement.style.cursor = 'pointer';
            this.summaryElement.title = 'Clique para configurar impressoras';
        }
    }

    // Método público para forçar atualização
    refresh() {
        this.loadPrinterConfig();
    }

    // Método para obter configuração atual
    getCurrentConfig() {
        return this.config;
    }
}

// Inicializar quando o script for carregado
if (typeof window !== 'undefined') {
    window.printerSummaryManager = new PrinterSummaryManager();
    
    // Disponibilizar globalmente para outros scripts
    window.refreshPrinterSummary = () => {
        if (window.printerSummaryManager) {
            window.printerSummaryManager.refresh();
        }
    };
}