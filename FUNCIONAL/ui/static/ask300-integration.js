/**
 * ASK-300 Integration JavaScript
 * Integração do controlador ASK-300 com a interface web do quiosque
 */

class ASK300Integration {
    constructor() {
        this.apiBase = '/api';
        this.paperSizes = {};
        this.printerStatus = null;
        this.isInitialized = false;
        
        this.init();
    }
    
    async init() {
        console.log('🔧 Inicializando integração ASK-300...');
        
        try {
            // Verificar se o sistema ASK-300 está disponível
            await this.checkSystemStatus();
            
            // Carregar tamanhos de papel disponíveis
            await this.loadPaperSizes();
            
            // Verificar status da impressora
            await this.checkPrinterStatus();
            
            this.isInitialized = true;
            console.log('✅ Integração ASK-300 inicializada com sucesso!');
            
            // Disparar evento personalizado
            window.dispatchEvent(new CustomEvent('ask300Ready', {
                detail: {
                    paperSizes: this.paperSizes,
                    printerStatus: this.printerStatus
                }
            }));
            
        } catch (error) {
            console.error('❌ Erro ao inicializar ASK-300:', error);
            this.showError('Sistema ASK-300 não disponível');
        }
    }
    
    async checkSystemStatus() {
        // Simulando status disponível para o servidor Node.js simplificado
        return { available: true, message: 'Sistema ASK-300 disponível' };
    }
    
    async loadPaperSizes() {
        // Definindo tamanhos de papel padrão para o servidor Node.js simplificado
        this.paperSizes = {
            '10x15': { width: 10, height: 15, name: '10x15 cm' },
            '15x20': { width: 15, height: 20, name: '15x20 cm' }
        };
        console.log('📄 Tamanhos de papel carregados:', this.paperSizes);
    }
    
    async checkPrinterStatus() {
        // Simulando status da impressora para o servidor Node.js simplificado
        this.printerStatus = {
            online: true,
            ready: true,
            paper_loaded: true,
            ink_level: 85
        };
        console.log('🖨️ Status da impressora:', this.printerStatus);
        
        return this.printerStatus;
    }
    
    /**
     * Imprime uma única foto
     * @param {File} file - Arquivo da imagem
     * @param {string} paperSize - Tamanho do papel (10x15 ou 15x20)
     * @param {number} copies - Número de cópias
     */
    async printSingle(file, paperSize = '10x15', copies = 1) {
        if (!this.isInitialized) {
            throw new Error('Sistema ASK-300 não inicializado');
        }
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('paper_size', paperSize);
        formData.append('copies', copies);
        
        try {
            this.showLoading(`Processando impressão ${paperSize}...`);
            
            const response = await fetch(`${this.apiBase}/ask300/print/single`, {
                method: 'POST',
                body: formData
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.showSuccess(result.message);
                console.log('✅ Impressão enviada:', result.job_details);
                return result;
            } else {
                throw new Error(result.error);
            }
            
        } catch (error) {
            console.error('❌ Erro na impressão:', error);
            this.showError(`Erro na impressão: ${error.message}`);
            throw error;
        } finally {
            this.hideLoading();
        }
    }
    
    /**
     * Imprime múltiplas fotos em lote
     * @param {Array} jobs - Array de trabalhos de impressão
     */
    async printBatch(jobs) {
        if (!this.isInitialized) {
            throw new Error('Sistema ASK-300 não inicializado');
        }
        
        try {
            this.showLoading(`Processando ${jobs.length} impressões...`);
            
            const response = await fetch(`${this.apiBase}/ask300/print/batch`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ jobs })
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.showSuccess(result.message);
                console.log('✅ Lote processado:', result.batch_details);
                return result;
            } else {
                throw new Error(result.error);
            }
            
        } catch (error) {
            console.error('❌ Erro no lote:', error);
            this.showError(`Erro no lote: ${error.message}`);
            throw error;
        } finally {
            this.hideLoading();
        }
    }
    
    /**
     * Executa impressão de teste
     * @param {string} paperSize - Tamanho do papel para teste
     */
    async printTest(paperSize = '10x15') {
        if (!this.isInitialized) {
            throw new Error('Sistema ASK-300 não inicializado');
        }
        
        try {
            this.showLoading(`Gerando teste ${paperSize}...`);
            
            const response = await fetch(`${this.apiBase}/ask300/print/test`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ paper_size: paperSize })
            });
            
            const result = await response.json();
            
            if (result.success) {
                this.showSuccess(`Teste ${paperSize} enviado para impressão!`);
                console.log('✅ Teste enviado:', result.job_details);
                return result;
            } else {
                throw new Error(result.error);
            }
            
        } catch (error) {
            console.error('❌ Erro no teste:', error);
            this.showError(`Erro no teste: ${error.message}`);
            throw error;
        } finally {
            this.hideLoading();
        }
    }
    
    /**
     * Cria seletor de tamanho de papel
     * @param {HTMLElement} container - Container onde inserir o seletor
     */
    createPaperSizeSelector(container) {
        if (!this.isInitialized || !this.paperSizes) {
            console.warn('Sistema ASK-300 não inicializado para criar seletor');
            return null;
        }
        
        const selectorHTML = `
            <div class="ask300-paper-selector">
                <label for="paper-size-select">📄 Tamanho do Papel:</label>
                <select id="paper-size-select" class="paper-size-select">
                    ${Object.entries(this.paperSizes).map(([key, config]) => 
                        `<option value="${key}">${config.name} (${config.width_px}x${config.height_px}px)</option>`
                    ).join('')}
                </select>
                <div class="paper-info">
                    <small id="paper-info-text">Selecione um tamanho para ver detalhes</small>
                </div>
            </div>
        `;
        
        container.innerHTML = selectorHTML;
        
        // Adicionar evento de mudança
        const select = container.querySelector('#paper-size-select');
        const infoText = container.querySelector('#paper-info-text');
        
        select.addEventListener('change', (e) => {
            const selectedSize = e.target.value;
            const config = this.paperSizes[selectedSize];
            
            if (config) {
                infoText.textContent = `${config.width_inches}"x${config.height_inches}" - ${config.dpi} DPI`;
            }
        });
        
        // Disparar evento inicial
        if (select.options.length > 0) {
            select.dispatchEvent(new Event('change'));
        }
        
        return select;
    }
    
    /**
     * Cria botões de teste de impressão
     * @param {HTMLElement} container - Container onde inserir os botões
     */
    createTestButtons(container) {
        if (!this.isInitialized) {
            console.warn('Sistema ASK-300 não inicializado para criar botões de teste');
            return;
        }
        
        const buttonsHTML = `
            <div class="ask300-test-buttons">
                <h4>🧪 Testes de Impressão</h4>
                <div class="test-button-group">
                    <button class="btn-test" data-size="10x15">Teste 10x15cm</button>
                    <button class="btn-test" data-size="15x20">Teste 15x20cm</button>
                </div>
                <small>Use os testes para verificar se a impressora está funcionando corretamente</small>
            </div>
        `;
        
        container.innerHTML = buttonsHTML;
        
        // Adicionar eventos aos botões
        container.querySelectorAll('.btn-test').forEach(button => {
            button.addEventListener('click', async (e) => {
                const size = e.target.dataset.size;
                try {
                    await this.printTest(size);
                } catch (error) {
                    console.error('Erro no teste:', error);
                }
            });
        });
    }
    
    /**
     * Mostra indicador de carregamento
     */
    showLoading(message = 'Processando...') {
        // Remover loading anterior se existir
        this.hideLoading();
        
        const loadingDiv = document.createElement('div');
        loadingDiv.id = 'ask300-loading';
        loadingDiv.className = 'ask300-loading';
        loadingDiv.innerHTML = `
            <div class="loading-content">
                <div class="spinner"></div>
                <p>${message}</p>
            </div>
        `;
        
        document.body.appendChild(loadingDiv);
    }
    
    /**
     * Esconde indicador de carregamento
     */
    hideLoading() {
        const loading = document.getElementById('ask300-loading');
        if (loading) {
            loading.remove();
        }
    }
    
    /**
     * Mostra mensagem de sucesso
     */
    showSuccess(message) {
        this.showNotification(message, 'success');
    }
    
    /**
     * Mostra mensagem de erro
     */
    showError(message) {
        this.showNotification(message, 'error');
    }
    
    /**
     * Mostra notificação
     */
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `ask300-notification ${type}`;
        notification.innerHTML = `
            <div class="notification-content">
                <span class="notification-icon">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
                <span class="notification-message">${message}</span>
                <button class="notification-close">×</button>
            </div>
        `;
        
        document.body.appendChild(notification);
        
        // Auto-remover após 5 segundos
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 5000);
        
        // Botão de fechar
        notification.querySelector('.notification-close').addEventListener('click', () => {
            notification.remove();
        });
    }
    
    /**
     * Obtém tamanho de papel selecionado
     */
    getSelectedPaperSize() {
        const select = document.getElementById('paper-size-select');
        return select ? select.value : '10x15';
    }
    
    /**
     * Verifica se o sistema está pronto
     */
    isReady() {
        return this.isInitialized && this.printerStatus && this.printerStatus.ask300_found;
    }
    
    /**
     * Obtém informações do sistema
     */
    getSystemInfo() {
        return {
            initialized: this.isInitialized,
            paperSizes: this.paperSizes,
            printerStatus: this.printerStatus,
            ready: this.isReady()
        };
    }
}

// CSS para os componentes
const ask300CSS = `
.ask300-paper-selector {
    margin: 15px 0;
    padding: 15px;
    border: 1px solid #ddd;
    border-radius: 8px;
    background: #f9f9f9;
}

.ask300-paper-selector label {
    display: block;
    margin-bottom: 8px;
    font-weight: bold;
    color: #333;
}

.paper-size-select {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #ccc;
    border-radius: 4px;
    font-size: 14px;
    background: white;
}

.paper-info {
    margin-top: 8px;
    color: #666;
}

.ask300-test-buttons {
    margin: 15px 0;
    padding: 15px;
    border: 1px solid #ddd;
    border-radius: 8px;
    background: #f0f8ff;
}

.test-button-group {
    display: flex;
    gap: 10px;
    margin: 10px 0;
}

.btn-test {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    background: #007bff;
    color: white;
    cursor: pointer;
    font-size: 14px;
    transition: background 0.3s;
}

.btn-test:hover {
    background: #0056b3;
}

.ask300-loading {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10000;
}

.loading-content {
    background: white;
    padding: 30px;
    border-radius: 8px;
    text-align: center;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.spinner {
    width: 40px;
    height: 40px;
    border: 4px solid #f3f3f3;
    border-top: 4px solid #007bff;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin: 0 auto 15px;
}

@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.ask300-notification {
    position: fixed;
    top: 20px;
    right: 20px;
    max-width: 400px;
    padding: 15px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    z-index: 9999;
    animation: slideIn 0.3s ease-out;
}

.ask300-notification.success {
    background: #d4edda;
    border: 1px solid #c3e6cb;
    color: #155724;
}

.ask300-notification.error {
    background: #f8d7da;
    border: 1px solid #f5c6cb;
    color: #721c24;
}

.ask300-notification.info {
    background: #d1ecf1;
    border: 1px solid #bee5eb;
    color: #0c5460;
}

.notification-content {
    display: flex;
    align-items: center;
    gap: 10px;
}

.notification-close {
    background: none;
    border: none;
    font-size: 18px;
    cursor: pointer;
    margin-left: auto;
    opacity: 0.7;
}

.notification-close:hover {
    opacity: 1;
}

@keyframes slideIn {
    from {
        transform: translateX(100%);
        opacity: 0;
    }
    to {
        transform: translateX(0);
        opacity: 1;
    }
}
`;

// Adicionar CSS ao documento
if (!document.getElementById('ask300-styles')) {
    const style = document.createElement('style');
    style.id = 'ask300-styles';
    style.textContent = ask300CSS;
    document.head.appendChild(style);
}

// Inicializar automaticamente quando o DOM estiver pronto
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.ask300 = new ASK300Integration();
    });
} else {
    window.ask300 = new ASK300Integration();
}

// Exportar para uso em módulos
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ASK300Integration;
}