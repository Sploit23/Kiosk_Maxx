// Gerenciador de Configurações Persistentes
class ConfigManager {
    constructor() {
        this.config = {};
        this.configPath = '/api/printer-config';
        this.autoSaveDelay = 1000; // 1 segundo
        this.saveTimeout = null;
        
        this.loadConfig();
    }

    // Carrega configurações do servidor
    async loadConfig() {
        try {
            console.log('🔧 Carregando configurações da impressora...');
            const response = await fetch(this.configPath);
            
            if (response.ok) {
                this.config = await response.json();
                console.log('✅ Configurações carregadas:', this.config);
                
                // Aplicar configurações carregadas
                this.applyLoadedConfig();
            } else {
                console.warn('⚠️ Usando configurações padrão');
                this.config = this.getDefaultConfig();
            }
        } catch (error) {
            console.error('❌ Erro ao carregar configurações:', error);
            this.config = this.getDefaultConfig();
        }
    }

    // Salva configurações no servidor
    async saveConfig() {
        try {
            // Atualizar status de tentativa
            const lastAttemptSpan = document.getElementById('last-save-attempt');
            if (lastAttemptSpan) {
                lastAttemptSpan.textContent = new Date().toLocaleString('pt-BR');
                lastAttemptSpan.style.color = '#ffc107';
            }
            
            // Atualiza timestamp da última sessão
            if (!this.config.user_preferences) {
            this.config.user_preferences = {};
        }
        this.config.user_preferences.last_session_date = new Date().toISOString();
            
            // CORRIGIDO: usar o endpoint correto
            const response = await fetch('/api/printer-config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(this.config)
            });
            
            if (response.ok) {
                console.log('✅ Configurações salvas com sucesso');
                
                // Atualizar status de sucesso
                const lastSuccessSpan = document.getElementById('last-save-success');
                if (lastSuccessSpan) {
                    lastSuccessSpan.textContent = new Date().toLocaleString('pt-BR');
                    lastSuccessSpan.style.color = '#28a745';
                }
                
                // Limpar erro anterior
                const lastErrorSpan = document.getElementById('last-save-error');
                if (lastErrorSpan) {
                    lastErrorSpan.textContent = 'Nenhum';
                    lastErrorSpan.style.color = '#6c757d';
                }
                
                // Atualizar resumo das configurações salvas
                if (typeof loadSavedConfigStatus === 'function') {
                    setTimeout(loadSavedConfigStatus, 500);
                }
                
            } else {
                console.error('❌ Erro ao salvar configurações');
                
                // Atualizar status de erro
                const lastErrorSpan = document.getElementById('last-save-error');
                if (lastErrorSpan) {
                    lastErrorSpan.textContent = `HTTP ${response.status}: ${response.statusText}`;
                    lastErrorSpan.style.color = '#dc3545';
                }
            }
        } catch (error) {
            console.error('❌ Erro ao salvar configurações:', error);
            
            // Atualizar status de erro
            const lastErrorSpan = document.getElementById('last-save-error');
            if (lastErrorSpan) {
                lastErrorSpan.textContent = error.message;
                lastErrorSpan.style.color = '#dc3545';
            }
        }
    }

    // Salva configurações com delay (debounce)
    saveConfigDelayed() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        
        this.saveTimeout = setTimeout(() => {
            this.saveConfig();
        }, this.autoSaveDelay);
    }

    // Atualiza impressora selecionada
    setSelectedPrinter(printerName) {
        this.config.last_used_printer = printerName;
        if (!this.config.user_preferences) {
            this.config.user_preferences = {};
        }
        this.config.user_preferences.default_printer = printerName;
        
        console.log(`🖨️ Impressora selecionada: ${printerName}`);
        this.saveConfigDelayed();
        
        // Notificar outros componentes
        window.dispatchEvent(new CustomEvent('printerChanged', {
            detail: { printer: printerName }
        }));
    }

    // Atualiza formato padrão
    setDefaultFormat(format) {
        if (!this.config.user_preferences) {
            this.config.user_preferences = {};
        }
        this.config.user_preferences.default_format = format;
        
        console.log(`📏 Formato padrão: ${format}`);
        this.saveConfigDelayed();
    }

    // Atualiza tamanho de papel padrão
    setDefaultPaperSize(paperSize) {
        if (!this.config.user_preferences) {
            this.config.user_preferences = {};
        }
        this.config.user_preferences.default_paper_size = paperSize;
        
        console.log(`📄 Tamanho de papel padrão: ${paperSize}`);
        this.saveConfigDelayed();
    }

    // Atualiza número de cópias padrão
    setDefaultCopies(copies) {
        if (!this.config.user_preferences) {
            this.config.user_preferences = {};
        }
        this.config.user_preferences.auto_print_copies = copies;
        
        console.log(`🔢 Cópias padrão: ${copies}`);
        this.saveConfigDelayed();
    }

    // Aplica configurações carregadas na interface
    applyLoadedConfig() {
        // Aplicar impressora padrão
        if (this.config.last_used_printer) {
            this.selectPrinterInUI(this.config.last_used_printer);
        }
        
        // Aplicar formato padrão
        if (this.config.user_preferences && this.config.user_preferences.default_format) {
            this.selectFormatInUI(this.config.user_preferences.default_format);
        }
        
        // Aplicar tamanho de papel padrão
        if (this.config.user_preferences && this.config.user_preferences.default_paper_size) {
            this.selectPaperSizeInUI(this.config.user_preferences.default_paper_size);
        }
        
        // Aplicar número de cópias padrão
        if (this.config.user_preferences && this.config.user_preferences.auto_print_copies) {
            this.setCopiesInUI(this.config.user_preferences.auto_print_copies);
        }
    }

    // Seleciona impressora na interface
    selectPrinterInUI(printerName) {
        const printerSelect = document.getElementById('printer-select');
        if (printerSelect) {
            printerSelect.value = printerName;
            console.log(`🎯 Impressora aplicada na UI: ${printerName}`);
        }
    }

    // Seleciona formato na interface
    selectFormatInUI(format) {
        const formatSelect = document.getElementById('format-select');
        if (formatSelect) {
            formatSelect.value = format;
            console.log(`🎯 Formato aplicado na UI: ${format}`);
        }
    }

    // Seleciona tamanho de papel na interface
    selectPaperSizeInUI(paperSize) {
        const paperSizeSelect = document.getElementById('paper-size-select');
        if (paperSizeSelect) {
            paperSizeSelect.value = paperSize;
            console.log(`🎯 Tamanho de papel aplicado na UI: ${paperSize}`);
        }
    }

    // Define número de cópias na interface
    setCopiesInUI(copies) {
        const copiesInput = document.getElementById('copies-input');
        if (copiesInput) {
            copiesInput.value = copies;
            console.log(`🎯 Cópias aplicadas na UI: ${copies}`);
        }
    }

    // Obtém configurações padrão
    getDefaultConfig() {
        return {
            "last_used_printer": "FUJIFILM ASK-300",
            "user_preferences": {
                "default_printer": "FUJIFILM ASK-300",
                "default_paper_size": "4x6",
                "default_format": "10x15",
                "auto_print_copies": 1,
                "last_session_date": new Date().toISOString()
            },
            "format_mappings": {
                "10x15": {
                    "printer": "FUJIFILM ASK-300",
                    "paper_size": "4x6",
                    "print_size": "4x6",
                    "java_class": "ImprimirFoto10x15ASK300"
                }
            },
            "available_printers": {
                "FUJIFILM ASK-300": {
                    "name": "FUJIFILM ASK-300",
                    "supported_paper_sizes": ["4x6", "6x8"],
                    "devmode_path": "spool_devmodes/FUJIFILM_ASK-300_devmode.bin",
                    "status": "online"
                }
            }
        };
    }

    // Getters para acessar configurações
    getSelectedPrinter() {
        return this.config.last_used_printer || 'FUJIFILM ASK-300';
    }

    getDefaultFormat() {
        return this.config.user_preferences?.default_format || '10x15';
    }

    getDefaultPaperSize() {
        return this.config.user_preferences?.default_paper_size || '4x6';
    }

    getDefaultCopies() {
        return this.config.user_preferences?.auto_print_copies || 1;
    }

    getFormatMapping(format) {
        return this.config.format_mappings?.[format] || null;
    }

    getAvailablePrinters() {
        return this.config.available_printers || {};
    }
}

// Instância global do gerenciador de configurações
let configManager;

// Inicializar quando a página carregar
document.addEventListener('DOMContentLoaded', () => {
    configManager = new ConfigManager();
    
    // Disponibilizar globalmente
    window.configManager = configManager;
});