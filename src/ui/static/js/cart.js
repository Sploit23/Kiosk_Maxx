// Sistema de Carrinho de Impressão - Kiosk de Fotos
class PrintCart {
    constructor() {
        this.items = [];
        this.isVisible = false;
        this.printerConfig = {};
        this.loadPrinterConfig();
        this.initializeCart();
    }

    async loadPrinterConfig() {
        try {
            const response = await fetch('/api/printer-config');
            if (response.ok) {
                const data = await response.json();
                this.printerConfig = data;
            } else {
                this.printerConfig = this.getDefaultPrinterConfig();
            }
        } catch (error) {
            console.error('Erro ao carregar configuração de impressoras:', error);
            this.printerConfig = this.getDefaultPrinterConfig();
        }
    }

    getDefaultPrinterConfig() {
        return {
            formats: {
                '10x15': {
                    printer: 'FUJIFILM ASK-300',
                    printSize: '4x6',
                    paperSize: '4x6'
                },
                '15x20': {
                    printer: 'FUJIFILM ASK-300',
                    printSize: '6x8',
                    paperSize: '6x8'
                },
                'Bolas': {
                    printer: 'FUJIFILM ASK-300',
                    printSize: 'custom',
                    paperSize: 'A4'
                }
            },
            printers: {
                'FUJIFILM ASK-300': 'FUJIFILM ASK-300'
            }
        };
    }

    initializeCart() {
        this.createCartUI();
        this.createCartButton();
    }

    async loadConfigInBackground() {
        try {
            // Aguarda o ConfigManager estar disponível
            let attempts = 0;
            while (!window.configManager && attempts < 50) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            
            if (window.configManager) {
                this.loadConfigFromManager();
                
                // Escuta mudanças de impressora
                window.addEventListener('printerChanged', (event) => {
                    console.log('🔄 Impressora alterada:', event.detail.printer);
                    this.loadConfigFromManager();
                });
            }
        } catch (error) {
            console.warn('⚠️ Usando configurações padrão do carrinho:', error);
        }
    }

    loadConfigFromManager() {
        if (window.configManager) {
            this.printerConfig = {
                selectedPrinter: window.configManager.getSelectedPrinter(),
                defaultFormat: window.configManager.getDefaultFormat(),
                defaultPaperSize: window.configManager.getDefaultPaperSize(),
                defaultCopies: window.configManager.getDefaultCopies(),
                formatMappings: window.configManager.config.format_mappings || {},
                availablePrinters: window.configManager.getAvailablePrinters()
            };
            
            console.log('📋 Configurações atualizadas no carrinho:', this.printerConfig);
        }
    }

    initializeCart() {
        this.createCartUI();
        this.createCartButton();
    }

    createCartButton() {
        // Remove botão existente se houver
        const existingButton = document.getElementById('cart-button');
        if (existingButton) {
            existingButton.remove();
        }
        
        const cartButton = document.createElement('button');
        cartButton.id = 'cart-button';
        cartButton.innerHTML = '🎄 Carrinho'; // Só isso - sem duplicação!
        cartButton.title = 'Carrinho de Impressão';
        cartButton.onclick = () => this.toggleCart();
        document.body.appendChild(cartButton);
    }

    toggleCart() {
        const cartContainer = document.getElementById('cart-container');
        if (!cartContainer) return;
        
        this.isVisible = !this.isVisible;
        
        if (this.isVisible) {
            cartContainer.className = 'cart-visible';
            this.updateCartDisplay();
        } else {
            cartContainer.className = 'cart-hidden';
        }
    }

    createCartUI() {
        const cartContainer = document.createElement('div');
        cartContainer.id = 'cart-container';
        cartContainer.className = 'cart-hidden';
        
        cartContainer.innerHTML = `
            <div class="cart-header">
                <h3>🖨️ Fila de Impressão</h3>
                <button class="cart-close" onclick="window.cart.toggleCart()">✕</button>
            </div>
            <div class="cart-content">
                <div id="cart-items"></div>
                <div class="cart-summary">
                    <div class="cart-total">
                        <div class="cart-total-line">
                            <span class="cart-total-items">Total de fotos: <span id="cart-total-count">0</span></span>
                            <span class="cart-total-price">R$ 0,00</span>
                        </div>
                    </div>
                    <div class="cart-actions">
                        <button class="cart-print" onclick="window.cart.printAll()">🖨️ Imprimir Todas</button>
                        <button class="cart-clear" onclick="window.cart.clearCart()">Limpar Fila</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(cartContainer);
    }

    addItem(photoName, event) {
        if (event) {
            event.stopPropagation();
        }
        
        // Extrair formato do nome da foto
        const format = this.extractFormat(photoName);
        
        const existingItem = this.items.find(item => 
            item.photoName === photoName && item.format === format
        );

        if (existingItem) {
            existingItem.quantity += 1;
        } else {
            this.items.push({
                photoName,
                format,
                quantity: 1
            });
        }

        this.updateCartUI();
        this.showNotification(`${this.shortenPhotoName(photoName)} adicionado à fila de impressão!`);
    }
    
    extractFormat(photoName) {
        // Extrair formato do nome da foto (ex: "10x15_20250808_100808.jpg" -> "10x15")
        if (photoName.includes('10x15')) return '10x15';
        if (photoName.includes('15x20')) return '15x20';
        if (photoName.includes('Bolas')) return 'Bolas';
        return '10x15'; // formato padrão
    }

    shortenPhotoName(photoName) {
        // Encurta o nome da foto para exibição
        if (photoName.length <= 20) return photoName;
        
        const extension = photoName.substring(photoName.lastIndexOf('.'));
        const nameWithoutExt = photoName.substring(0, photoName.lastIndexOf('.'));
        
        if (nameWithoutExt.length <= 15) {
            return photoName;
        }
        
        return nameWithoutExt.substring(0, 15) + '...' + extension;
    }

    removeFromCart(photoName, format) {
        const itemIndex = this.items.findIndex(item => 
            item.photoName === photoName && item.format === format
        );

        if (itemIndex > -1) {
            this.items.splice(itemIndex, 1);
            this.updateCartUI();
        }
    }

    updateQuantity(photoName, format, newQuantity) {
        const item = this.items.find(item => 
            item.photoName === photoName && item.format === format
        );

        if (item) {
            if (newQuantity <= 0) {
                this.removeFromCart(photoName, format);
            } else {
                item.quantity = newQuantity;
                this.updateCartUI();
            }
        }
    }

    calculateTotalPhotos() {
        return this.items.reduce((total, item) => {
            return total + item.quantity;
        }, 0);
    }

    // Adicionar função para buscar preços
    async loadPricing() {
        try {
            const response = await fetch('/config/pricing.json');
            this.pricing = await response.json();
        } catch (error) {
            console.error('Erro ao carregar preços:', error);
            this.pricing = { default_price: 15, formats: { '10x15': 15, '15x21': 25, '20x30': 35 } };
        }
    }

    // Função para calcular preço
    getPrice(format) {
        if (!this.pricing) return 15;
        return this.pricing.formats[format] || this.pricing.default_price || 15;
    }

    // Atualizar updateCartUI para incluir preços
    updateCartUI() {
        const cartItems = document.getElementById('cart-items');
        const cartTotalCount = document.getElementById('cart-total-count');
        
        if (this.items.length === 0) {
            cartItems.innerHTML = '<div class="cart-empty">Fila de impressão vazia</div>';
            document.querySelector('.cart-total-price').textContent = 'R$ 0,00';
            return;
        }
        
        let totalPrice = 0;
        let totalPhotos = 0;
        
        // Na função updateCartUI(), trocar as referências dos botões:
        cartItems.innerHTML = this.items.map(item => {
        const price = this.getPrice(item.format);
        const subtotal = price * item.quantity;
        totalPrice += subtotal;
        totalPhotos += item.quantity;
        
        return `
            <div class="cart-item">
                <div class="cart-item-header">
                    <div class="cart-item-thumbnail">
                        <img src="/imagens/${item.photoName}" alt="${item.photoName}" class="cart-thumbnail">
                    </div>
                    <div class="cart-item-info">
                        <div class="cart-item-name">${this.shortenPhotoName(item.photoName)}</div>
                        <div class="cart-item-format">Formato: ${item.format}</div>
                        <div class="cart-item-price">Preço unitário: R$ ${price.toFixed(2).replace('.', ',')}</div>
                    </div>
                    <button class="remove-btn" onclick="window.cart.removeFromCart('${item.photoName}', '${item.format}')" title="Remover item">🗑️</button>
                </div>
                <div class="cart-item-controls">
                    <div class="quantity-section">
                        <label class="quantity-label">Quantidade:</label>
                        <div class="quantity-controls">
                            <button class="quantity-btn" onclick="window.cart.updateQuantity('${item.photoName}', '${item.format}', ${item.quantity - 1})">-</button>
                            <div class="quantity-display">${item.quantity}</div>
                            <button class="quantity-btn" onclick="window.cart.updateQuantity('${item.photoName}', '${item.format}', ${item.quantity + 1})">+</button>
                        </div>
                    </div>
                    <div class="subtotal-section">
                        <div class="cart-item-subtotal">Total: R$ ${subtotal.toFixed(2).replace('.', ',')}</div>
                    </div>
                </div>
            </div>
            `;
        }).join('');
        
        // Atualizar totais
        document.querySelector('.cart-total-items').textContent = `Total de fotos: ${totalPhotos}`;
        document.querySelector('.cart-total-price').textContent = `TOTAL: R$ ${totalPrice.toFixed(2).replace('.', ',')}`;
    }

    toggleCart() {
        const cartContainer = document.getElementById('cart-container');
        this.isVisible = !this.isVisible;
        
        if (this.isVisible) {
            cartContainer.className = 'cart-visible';
        } else {
            cartContainer.className = 'cart-hidden';
        }
    }

    clearCart() {
        if (confirm('Tem certeza que deseja limpar toda a fila de impressão?')) {
            this.items = [];
            this.updateCartUI();
            this.showNotification('Fila de impressão limpa!');
        }
    }



    // Função para mostrar confirmação antes de imprimir
    showPrintConfirmation() {
        if (this.items.length === 0) {
            this.showNotification('Nenhuma foto na fila de impressão!', 'warning');
            return;
        }

        // Criar modal de confirmação personalizado
        const modal = document.createElement('div');
        modal.className = 'print-confirmation-modal';
        modal.innerHTML = `
            <div class="print-confirmation-content">
                <div class="confirmation-header">
                    <h3>🖨️ Confirmar Impressão</h3>
                </div>
                <div class="confirmation-body">
                    <p>Deseja imprimir <strong>${this.items.length}</strong> foto(s)?</p>
                    <div class="confirmation-details">
                        ${this.items.map(item => `
                            <div class="print-item-preview">
                                <span>${this.shortenPhotoName(item.photoName)}</span>
                                <span class="format-badge">${item.format}</span>
                                <span class="quantity-badge">×${item.quantity}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="confirmation-actions">
                    <button class="btn-cancel" onclick="this.closest('.print-confirmation-modal').remove()">❌ Cancelar</button>
                    <button class="btn-confirm" onclick="window.cart.confirmPrint(); this.closest('.print-confirmation-modal').remove()">✅ Imprimir</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Fechar modal ao clicar fora
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    async confirmPrint() {
        try {
            console.log('🚀 Iniciando impressão confirmada...');
            const printJobs = await this.preparePrintJobs();
            
            if (printJobs.length === 0) {
                this.showNotification('Erro ao preparar jobs de impressão!', 'error');
                return;
            }
            
            const response = await fetch('/api/print-batch-java', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ jobs: printJobs })
            });
            
            if (response.ok) {
                const result = await response.json();
                
                if (result.success) {
                    this.showNotification('✅ Fotos enviadas para impressão!', 'success');
                    
                    // Mostrar detalhes se houver erros
                    if (result.results && Array.isArray(result.results)) {
                        const successCount = result.results.filter(r => r.success).length;
                        const errorCount = result.results.filter(r => !r.success).length;
                        
                        if (errorCount > 0) {
                            console.warn(`${errorCount} impressões falharam:`, result.results.filter(r => !r.success));
                            this.showNotification(`⚠️ ${successCount} impressas, ${errorCount} falharam`, 'warning');
                        }
                    }
                    
                    // Limpar fila automaticamente após impressão bem-sucedida
                    this.items = [];
                    this.updateCartUI();
                    
                } else {
                    throw new Error(result.message || 'Erro na impressão');
                }
            } else {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Erro ao enviar para impressão');
            }
            
        } catch (error) {
            console.error('❌ Erro na impressão:', error);
            this.showNotification('Erro ao imprimir fotos: ' + error.message, 'error');
        }
    }

    // Manter função printAll() para compatibilidade, mas redirecionar para confirmação
    async printAll() {
        this.showPrintConfirmation();
    }

    async preparePrintJobs() {
        const jobs = [];
        
        // Garantir que o ConfigManager esteja carregado
        if (!window.configManager) {
            console.warn('⚠️ ConfigManager não disponível, aguardando...');
            // Aguardar até 5 segundos pelo ConfigManager
            for (let i = 0; i < 50; i++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (window.configManager) break;
            }
        }
        
        this.items.forEach(item => {
            let format = item.format;
            let javaScript = 'ImprimirFoto10x15ASK300'; // padrão
            let printer = 'FUJIFILM ASK-300'; // padrão fallback
            let paperSize = '4x6'; // padrão
            
            // Obter configuração do formato
            const formatConfig = window.configManager?.getFormatMapping(format);
            console.log(`🔍 DEBUG IMPRESSÃO - Formato: ${format}`);
            console.log(`🔍 DEBUG IMPRESSÃO - ConfigManager disponível: ${!!window.configManager}`);
            console.log(`🔍 DEBUG IMPRESSÃO - Config completo:`, window.configManager?.config);
            console.log(`🔍 DEBUG IMPRESSÃO - FormatConfig encontrado:`, formatConfig);
            console.log(`🔍 DEBUG IMPRESSÃO - Impressora padrão: ${printer}`);
            console.log(`🔍 DEBUG IMPRESSÃO - Paper size padrão: ${paperSize}`);
            
            if (formatConfig && formatConfig.java_class) {
                javaScript = formatConfig.java_class;
                printer = formatConfig.printer || printer;
                paperSize = formatConfig.paper_size || paperSize;
                console.log(`✅ Usando configuração: javaScript=${javaScript}, printer=${printer}, paperSize=${paperSize}`);
            } else {
                console.log(`⚠️ Usando configuração padrão para formato ${format}`);
                // Fallback manual para 15x20
                if (format === '15x20') {
                    javaScript = 'ImprimirFoto15x20ASK300';
                    paperSize = '6x8';
                    console.log(`🔧 Fallback manual aplicado: javaScript=${javaScript}, paperSize=${paperSize}`);
                }
            }
            
            for (let i = 0; i < item.quantity; i++) {
                jobs.push({
                    photoName: item.photoName,
                    format: format,
                    javaScript: javaScript,
                    printer: printer,
                    paperSize: paperSize,
                    originalFormat: item.format
                });
            }
        });
        
        return jobs;
    }

    showNotification(message, type = 'success') {
        // Remove notificação existente
        const existingNotification = document.querySelector('.cart-notification');
        if (existingNotification) {
            existingNotification.remove();
        }

        const notification = document.createElement('div');
        notification.className = `cart-notification ${type}`;
        notification.innerHTML = `
            <div class="notification-content">
                <span class="notification-icon">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
                <span class="notification-message">${message}</span>
            </div>
        `;
        
        document.body.appendChild(notification);
        
        // Remove automaticamente após 3 segundos
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 3000);
    }
}

// Inicializar carrinho quando a página carregar
let cart;
document.addEventListener('DOMContentLoaded', () => {
    cart = new PrintCart();
    window.cart = cart; // Garantir acesso global
    console.log('🛒 Carrinho inicializado:', cart);
});