/**
 * Integração ASK-300 com Sistema de Kiosk
 * Conecta o controlador ASK-300 com a interface existente do quiosque
 */

(function() {
    'use strict';
    
    let currentSelectedImage = null;
    let ask300Ready = false;
    
    // Aguardar inicialização do ASK-300
    window.addEventListener('ask300Ready', function(event) {
        console.log('🎯 ASK-300 pronto para integração com kiosk');
        ask300Ready = true;
        initializeKioskIntegration(event.detail);
    });
    
    function initializeKioskIntegration(ask300Data) {
        // Mostrar painel ASK-300
        const panel = document.getElementById('ask300-panel');
        if (panel) {
            panel.style.display = 'block';
        }
        
        // Configurar seletor de papel
        const paperContainer = document.getElementById('paper-size-container');
        if (paperContainer && window.ask300) {
            window.ask300.createPaperSizeSelector(paperContainer);
        }
        
        // Configurar botões de teste
        const testContainer = document.getElementById('test-buttons-container');
        if (testContainer && window.ask300) {
            window.ask300.createTestButtons(testContainer);
        }
        
        // Configurar eventos
        setupKioskEvents();
        
        // Atualizar status na interface
        updatePrinterStatus(ask300Data.printerStatus);
    }
    
    function setupKioskEvents() {
        // Botão de toggle do painel
        const toggleBtn = document.getElementById('toggle-ask300');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', toggleASK300Panel);
        }
        
        // Botão de imprimir foto atual
        const printBtn = document.getElementById('print-current-photo');
        if (printBtn) {
            printBtn.addEventListener('click', printCurrentPhoto);
        }
        
        // Monitorar seleção de fotos
        observePhotoSelection();
        
        // Integrar com carrinho existente
        integrateWithCart();
    }
    
    function toggleASK300Panel() {
        const panel = document.getElementById('ask300-panel');
        const content = panel.querySelector('.panel-content');
        
        if (content.style.display === 'none') {
            content.style.display = 'block';
        } else {
            content.style.display = 'none';
        }
    }
    
    async function printCurrentPhoto() {
        if (!currentSelectedImage || !ask300Ready || !window.ask300) {
            alert('Selecione uma foto primeiro ou aguarde o sistema ASK-300 inicializar.');
            return;
        }
        
        try {
            // Obter configurações de impressora salvas
            const printerConfig = await loadPrinterConfiguration();
            
            // Obter configurações
            const paperSize = window.ask300.getSelectedPaperSize();
            const copies = parseInt(document.getElementById('copies-input').value) || 1;
            
            // Determinar a impressora correta baseada no formato
            const formatConfig = (printerConfig.formats && printerConfig.formats[paperSize]) || (printerConfig.format_mappings && printerConfig.format_mappings[paperSize]);
            let selectedPrinter = null;
            let selectedPaperSize = paperSize;
            
            if (formatConfig && formatConfig.printer) {
                selectedPrinter = formatConfig.printer;
                selectedPaperSize = formatConfig.paperSize || paperSize;
                console.log(`Usando impressora configurada: ${selectedPrinter} para formato ${paperSize}`);
            } else {
                console.log(`Usando configuração padrão para formato ${paperSize}`);
            }
            
            // Converter imagem para blob
            const imageBlob = await getImageAsBlob(currentSelectedImage);
            
            // Criar arquivo
            const fileName = `foto_${Date.now()}.jpg`;
            const file = new File([imageBlob], fileName, { type: 'image/jpeg' });
            
            // Se temos uma impressora específica configurada, usar o sistema de impressão Java
            if (selectedPrinter && selectedPrinter !== 'default') {
                await printWithConfiguredPrinter(file, selectedPrinter, selectedPaperSize, copies);
            } else {
                await window.ask300.printSingle(file, paperSize, copies);
            }
            try { window.incrementDailyPrintCount && window.incrementDailyPrintCount(selectedPaperSize || paperSize, copies); } catch (_) {}
            
            // Registrar no sistema de vendas (se disponível)
            if (typeof registerSale === 'function') {
                registerSale({
                    image: currentSelectedImage,
                    format: paperSize,
                    quantity: copies,
                    payment_method: selectedPrinter ? 'configured_printer' : 'ask300_direct'
                });
            }
            
        } catch (error) {
            console.error('Erro ao imprimir foto:', error);
            alert(`Erro na impressão: ${error.message}`);
        }
    }
    
    function observePhotoSelection() {
        // Observar mudanças na foto grande
        const fotoGrande = document.getElementById('foto-grande');
        if (!fotoGrande) return;
        
        const observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(mutation) {
                if (mutation.type === 'childList') {
                    const img = fotoGrande.querySelector('img');
                    if (img && img.src !== currentSelectedImage) {
                        currentSelectedImage = img.src;
                        updatePrintButton(true);
                        console.log('📸 Foto selecionada para ASK-300:', currentSelectedImage);
                    }
                }
            });
        });
        
        observer.observe(fotoGrande, {
            childList: true,
            subtree: true
        });
        
        // Verificar se já há uma imagem selecionada
        const existingImg = fotoGrande.querySelector('img');
        if (existingImg) {
            currentSelectedImage = existingImg.src;
            updatePrintButton(true);
        }
    }
    
    function updatePrintButton(enabled) {
        const printBtn = document.getElementById('print-current-photo');
        if (printBtn) {
            printBtn.disabled = !enabled || !ask300Ready;
            
            if (enabled && ask300Ready) {
                printBtn.textContent = '📸 Imprimir Foto Atual';
                printBtn.style.opacity = '1';
            } else {
                printBtn.textContent = enabled ? '⏳ Aguardando ASK-300...' : '📸 Selecione uma Foto';
                printBtn.style.opacity = '0.6';
            }
        }
    }
    
    function integrateWithCart() {
        // Adicionar opção ASK-300 ao carrinho existente
        if (typeof window.addToCart === 'function') {
            const originalAddToCart = window.addToCart;
            
            window.addToCart = function(imageSrc, format, price) {
                // Verificar se é impressão ASK-300
                if (format === '10x15' || format === '15x20') {
                    const useASK300 = confirm(
                        `Deseja usar a impressora ASK-300 para ${format}?\n\n` +
                        'ASK-300: Impressão direta com configuração automática de papel\n' +
                        'Carrinho: Adicionar ao carrinho para impressão posterior'
                    );
                    
                    if (useASK300 && ask300Ready && window.ask300) {
                        printImageWithASK300(imageSrc, format);
                        return;
                    }
                }
                
                // Usar carrinho original
                originalAddToCart(imageSrc, format, price);
            };
        }
    }
    
    async function printImageWithASK300(imageSrc, format) {
        try {
            const copies = parseInt(prompt('Quantas cópias? (1-10)', '1')) || 1;
            
            if (copies < 1 || copies > 10) {
                alert('Número de cópias deve ser entre 1 e 10');
                return;
            }
            
            // Obter configurações de impressora salvas
            const printerConfig = await loadPrinterConfiguration();
            
            // Determinar a impressora correta baseada no formato
            const formatConfig = (printerConfig.formats && printerConfig.formats[format]) || (printerConfig.format_mappings && printerConfig.format_mappings[format]);
            let selectedPrinter = null;
            let selectedPaperSize = format;
            
            if (formatConfig && formatConfig.printer) {
                selectedPrinter = formatConfig.printer;
                selectedPaperSize = formatConfig.paperSize || format;
                console.log(`Usando impressora configurada: ${selectedPrinter} para formato ${format}`);
            }
            
            // Converter imagem para blob
            const imageBlob = await getImageAsBlob(imageSrc);
            
            // Criar arquivo
            const fileName = `foto_${Date.now()}.jpg`;
            const file = new File([imageBlob], fileName, { type: 'image/jpeg' });
            
            // Se temos uma impressora específica configurada, usar o sistema de impressão Java
            if (selectedPrinter && selectedPrinter !== 'default') {
                await printWithConfiguredPrinter(file, selectedPrinter, selectedPaperSize, copies);
            } else {
                await window.ask300.printSingle(file, format, copies);
            }
            try { window.incrementDailyPrintCount && window.incrementDailyPrintCount(selectedPaperSize || format, copies); } catch (_) {}
            
        } catch (error) {
            console.error('Erro na impressão ASK-300:', error);
            alert(`Erro na impressão: ${error.message}`);
        }
    }
    
    async function getImageAsBlob(imageSrc) {
        try {
            // Se for uma URL relativa, converter para absoluta
            let fullUrl = imageSrc;
            if (imageSrc.startsWith('/')) {
                fullUrl = window.location.origin + imageSrc;
            }
            
            const response = await fetch(fullUrl);
            if (!response.ok) {
                throw new Error(`Erro ao carregar imagem: ${response.status}`);
            }
            
            return await response.blob();
            
        } catch (error) {
            console.error('Erro ao converter imagem:', error);
            throw error;
        }
    }
    
    function updatePrinterStatus(status) {
        // Atualizar indicadores visuais do status da impressora
        const panel = document.getElementById('ask300-panel');
        if (!panel) return;
        
        let statusClass = 'status-unknown';
        let statusText = 'Status desconhecido';
        let statusIcon = '❓';
        
        if (status) {
            if (status.ask300_found) {
                statusClass = 'status-ready';
                statusText = `Impressora encontrada: ${status.ask300_name}`;
                statusIcon = '✅';
            } else {
                statusClass = 'status-not-found';
                statusText = 'Impressora ASK-300 não encontrada';
                statusIcon = '❌';
            }
            
            if (status.simulation_mode) {
                statusClass = 'status-simulation';
                statusText = 'Modo simulação ativo';
                statusIcon = '🧪';
            }
        }
        
        // Adicionar ou atualizar indicador de status
        let statusIndicator = panel.querySelector('.printer-status');
        if (!statusIndicator) {
            statusIndicator = document.createElement('div');
            statusIndicator.className = 'printer-status';
            panel.querySelector('.panel-header').appendChild(statusIndicator);
        }
        
        statusIndicator.className = `printer-status ${statusClass}`;
        statusIndicator.innerHTML = `${statusIcon} ${statusText}`;
    }
    
    // Adicionar CSS específico para integração
    const kioskIntegrationCSS = `
        .ask300-panel {
            margin: 20px 0;
            border: 2px solid #007bff;
            border-radius: 10px;
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }
        
        .panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px 20px;
            background: #007bff;
            color: white;
            border-radius: 8px 8px 0 0;
        }
        
        .panel-header h3 {
            margin: 0;
            font-size: 18px;
        }
        
        .btn-toggle {
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.3);
            color: white;
            padding: 5px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .btn-toggle:hover {
            background: rgba(255, 255, 255, 0.3);
        }
        
        .panel-content {
            padding: 20px;
        }
        
        .print-actions {
            margin-top: 20px;
            padding: 15px;
            background: white;
            border-radius: 8px;
            border: 1px solid #dee2e6;
        }
        
        .btn-print {
            width: 100%;
            padding: 12px;
            background: #28a745;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s;
            margin-bottom: 10px;
        }
        
        .btn-print:hover:not(:disabled) {
            background: #218838;
            transform: translateY(-1px);
        }
        
        .btn-print:disabled {
            background: #6c757d;
            cursor: not-allowed;
            transform: none;
        }
        
        .copies-control {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .copies-control label {
            font-weight: bold;
            color: #495057;
        }
        
        .copies-control input {
            width: 60px;
            padding: 5px;
            border: 1px solid #ced4da;
            border-radius: 4px;
            text-align: center;
        }
        
        .printer-status {
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.2);
        }
        
        .status-ready {
            background: rgba(40, 167, 69, 0.2) !important;
        }
        
        .status-not-found {
            background: rgba(220, 53, 69, 0.2) !important;
        }
        
        .status-simulation {
            background: rgba(255, 193, 7, 0.2) !important;
        }
        
        @media (max-width: 768px) {
            .ask300-panel {
                margin: 10px;
            }
            
            .panel-header {
                padding: 10px 15px;
            }
            
            .panel-content {
                padding: 15px;
            }
        }
    `;
    
    // Adicionar CSS ao documento
    if (!document.getElementById('ask300-kiosk-styles')) {
        const style = document.createElement('style');
        style.id = 'ask300-kiosk-styles';
        style.textContent = kioskIntegrationCSS;
        document.head.appendChild(style);
    }
    
    // Função para carregar configurações de impressora
    async function loadPrinterConfiguration() {
        try {
            const response = await fetch('/api/printer-config');
            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            console.warn('Não foi possível carregar configurações de impressora:', error);
        }
        
        // Retornar configuração padrão se não conseguir carregar
        return {
            formats: {
                '10x15': { printer: 'default', paperSize: '10x15' },
                '15x20': { printer: 'default', paperSize: '15x20' }
            }
        };
    }
    
    // Função para imprimir com impressora configurada
     async function printWithConfiguredPrinter(file, printerName, paperSize, copies) {
         try {
             console.log(`Imprimindo com impressora configurada: ${printerName}, formato: ${paperSize}, cópias: ${copies}`);
             
             // Converter arquivo para base64
             const imageData = await fileToBase64(file);
             
             // Enviar para API de impressão configurada
             const response = await fetch('/api/print-configured', {
                 method: 'POST',
                 headers: {
                     'Content-Type': 'application/json'
                 },
                 body: JSON.stringify({
                     image_data: imageData,
                     printer_name: printerName,
                     paper_size: paperSize,
                     copies: copies
                 })
             });
             
             const result = await response.json();
             
             if (result.success) {
                 console.log('✅ Impressão enviada com sucesso:', result);
                 // Mostrar notificação de sucesso
                 showPrintNotification(result.message, 'success');
             } else {
                 throw new Error(result.message || 'Erro na impressão');
             }
             
         } catch (error) {
             console.error('❌ Erro na impressão configurada:', error);
             showPrintNotification(`Erro na impressão: ${error.message}`, 'error');
             throw error;
         }
     }
     
     // Função auxiliar para converter arquivo para base64
     async function fileToBase64(file) {
         return new Promise((resolve, reject) => {
             const reader = new FileReader();
             reader.onload = () => resolve(reader.result);
             reader.onerror = reject;
             reader.readAsDataURL(file);
         });
     }
     
     // Função para mostrar notificações de impressão
     function showPrintNotification(message, type = 'info') {
         const notification = document.createElement('div');
         notification.className = `print-notification ${type}`;
         notification.innerHTML = `
             <div class="notification-content">
                 <span class="notification-icon">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
                 <span class="notification-message">${message}</span>
             </div>
         `;
         
         // Adicionar estilos se não existirem
         if (!document.querySelector('#print-notification-styles')) {
             const styles = document.createElement('style');
             styles.id = 'print-notification-styles';
             styles.textContent = `
                 .print-notification {
                     position: fixed;
                     top: 20px;
                     right: 20px;
                     background: white;
                     border-radius: 8px;
                     padding: 15px;
                     box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                     z-index: 10000;
                     max-width: 400px;
                     animation: slideIn 0.3s ease-out;
                 }
                 .print-notification.success {
                     border-left: 4px solid #28a745;
                 }
                 .print-notification.error {
                     border-left: 4px solid #dc3545;
                 }
                 .print-notification.info {
                     border-left: 4px solid #17a2b8;
                 }
                 .notification-content {
                     display: flex;
                     align-items: center;
                     gap: 10px;
                 }
                 .notification-icon {
                     font-size: 18px;
                 }
                 .notification-message {
                     flex: 1;
                     font-weight: 500;
                 }
                 @keyframes slideIn {
                     from { transform: translateX(100%); opacity: 0; }
                     to { transform: translateX(0); opacity: 1; }
                 }
             `;
             document.head.appendChild(styles);
         }
         
         document.body.appendChild(notification);
         
         // Remover após 5 segundos
         setTimeout(() => {
             notification.style.animation = 'slideIn 0.3s ease-out reverse';
             setTimeout(() => notification.remove(), 300);
         }, 5000);
     }
    
    // Inicializar quando o DOM estiver pronto
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            console.log('🔧 Integração ASK-300 com Kiosk inicializada');
        });
    }
    
})();