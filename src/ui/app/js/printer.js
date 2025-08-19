// Serviço de impressão para o Kiosk de Fotos
class PrinterService {
    constructor() {
        this.printQueue = [];
        this.isPrinting = false;
        this.availablePrinters = [];
        this.defaultPrinter = '';
        
        // Carrega a lista de impressoras disponíveis
        this.loadPrinters();
    }
    
    async loadPrinters() {
        try {
            const response = await fetch('/api/printers');
            if (response.ok) {
                const data = await response.json();
                this.availablePrinters = data.printers || [];
                this.defaultPrinter = data.default_printer || '';
                console.log('Impressoras carregadas:', this.availablePrinters);
            }
        } catch (error) {
            console.error('Erro ao carregar impressoras:', error);
        }
    }

    async printImage(imageUrl, printerName = 'default') {
        return new Promise((resolve, reject) => {
            // Adiciona à fila de impressão
            this.printQueue.push({ imageUrl, printerName, resolve, reject });
            
            if (!this.isPrinting) {
                this.processQueue();
            }
        });
    }

    async processQueue() {
        if (this.printQueue.length === 0) {
            this.isPrinting = false;
            return;
        }
        
        this.isPrinting = true;
        const { imageUrl, printerName, resolve, reject } = this.printQueue.shift();
        
        try {
            // Simula comunicação com o servidor de impressão
            const result = await this.sendPrintCommand(imageUrl, printerName);
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            // Processa o próximo item da fila
            this.processQueue();
        }
    }
    
    async sendPrintCommand(imageUrl, printerName) {
        try {
            // Faz requisição para a API de impressão
            const response = await fetch('/api/print', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    image_path: imageUrl.split('/').pop(),
                    printer_name: printerName
                })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Erro ao imprimir');
            }
            
            const result = await response.json();
            
            // Notifica o usuário sobre o status da impressão
            this.notifyPrintStatus(result);
            
            return result;
        } catch (error) {
            console.error('Erro de impressão:', error);
            this.notifyPrintStatus({ status: 'error', message: error.message });
            throw error;
        }
    }
    
    // Método para notificar o usuário sobre o status da impressão
    notifyPrintStatus(result) {
        const statusElement = document.createElement('div');
        statusElement.className = 'print-status';
        
        if (result.status === 'sent' || result.status === 'success') {
            statusElement.classList.add('success');
            statusElement.innerHTML = '<i class="status-icon">✓</i> Foto enviada para impressão!';
        } else {
            statusElement.classList.add('error');
            statusElement.innerHTML = '<i class="status-icon">✗</i> Erro na impressão: ' + (result.message || 'Erro desconhecido');
        }
        
        // Adiciona o elemento à página
        document.body.appendChild(statusElement);
        
        // Animação de entrada
        setTimeout(() => {
            statusElement.style.opacity = '1';
            statusElement.style.transform = 'translateY(0)';
        }, 100);
        
        // Remove após 5 segundos
        setTimeout(() => {
            statusElement.style.opacity = '0';
            statusElement.style.transform = 'translateY(-20px)';
            setTimeout(() => {
                if (statusElement.parentNode) {
                    statusElement.parentNode.removeChild(statusElement);
                }
            }, 300);
        }, 5000);
    }
    
    // Retorna a lista de impressoras disponíveis
    getPrinters() {
        return this.availablePrinters;
    }
    
    // Retorna a impressora padrão
    getDefaultPrinter() {
        return this.defaultPrinter;
    }
    
    // Método para testar a impressora
    async testPrinter(printerName = null) {
        try {
            const response = await fetch('/api/test-printer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    printer_name: printerName || this.defaultPrinter
                })
            });
            
            const result = await response.json();
            this.notifyPrintStatus(result);
            
            return result;
        } catch (error) {
            console.error('Erro ao testar impressora:', error);
            this.notifyPrintStatus({ status: 'error', message: 'Erro ao testar impressora' });
            throw error;
        }
    }
    
    // Método para obter status da impressora
    async getPrinterStatus(printerName = null) {
        try {
            const response = await fetch(`/api/printer-status?printer=${encodeURIComponent(printerName || this.defaultPrinter)}`);
            
            if (response.ok) {
                return await response.json();
            } else {
                throw new Error('Erro ao obter status da impressora');
            }
        } catch (error) {
            console.error('Erro ao obter status da impressora:', error);
            return { status: 'unknown', message: 'Status não disponível' };
        }
    }
}

// Inicializa o serviço de impressão globalmente
if (typeof window !== 'undefined') {
    window.printerService = new PrinterService();
}