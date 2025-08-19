// Sistema de Auto-Update para Photo Kiosk Desktop
class UpdateManager {
    constructor() {
        this.updateNotification = null;
        this.progressBar = null;
        this.init();
    }

    init() {
        // Verificar se estamos no Electron
        if (typeof window.electronAPI !== 'undefined') {
            this.setupUpdateListeners();
            this.createUpdateUI();
            this.checkAppVersion();
        }
    }

    setupUpdateListeners() {
        // Listener para progresso de download
        window.electronAPI.onDownloadProgress((progress) => {
            this.showDownloadProgress(progress);
        });

        // Listener para atualização disponível
        window.electronAPI.onUpdateAvailable((info) => {
            this.showUpdateAvailable(info);
        });

        // Listener para atualização baixada
        window.electronAPI.onUpdateDownloaded((info) => {
            this.showUpdateReady(info);
        });
    }

    createUpdateUI() {
        // Criar container para notificações de update
        const updateContainer = document.createElement('div');
        updateContainer.id = 'update-container';
        updateContainer.innerHTML = `
            <style>
                #update-container {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    z-index: 10000;
                    font-family: 'Poppins', sans-serif;
                }
                
                .update-notification {
                    background: linear-gradient(135deg, #4CAF50, #45a049);
                    color: white;
                    padding: 15px 20px;
                    border-radius: 10px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                    margin-bottom: 10px;
                    min-width: 300px;
                    animation: slideInRight 0.5s ease-out;
                    border-left: 4px solid #2E7D32;
                }
                
                .update-notification.warning {
                    background: linear-gradient(135deg, #FF9800, #F57C00);
                    border-left-color: #E65100;
                }
                
                .update-notification.info {
                    background: linear-gradient(135deg, #2196F3, #1976D2);
                    border-left-color: #0D47A1;
                }
                
                .update-title {
                    font-weight: 600;
                    font-size: 16px;
                    margin-bottom: 5px;
                    display: flex;
                    align-items: center;
                }
                
                .update-message {
                    font-size: 14px;
                    opacity: 0.9;
                    line-height: 1.4;
                }
                
                .update-progress {
                    margin-top: 10px;
                }
                
                .progress-bar {
                    width: 100%;
                    height: 6px;
                    background: rgba(255,255,255,0.3);
                    border-radius: 3px;
                    overflow: hidden;
                }
                
                .progress-fill {
                    height: 100%;
                    background: white;
                    border-radius: 3px;
                    transition: width 0.3s ease;
                    width: 0%;
                }
                
                .progress-text {
                    font-size: 12px;
                    margin-top: 5px;
                    opacity: 0.8;
                }
                
                .update-buttons {
                    margin-top: 10px;
                    display: flex;
                    gap: 10px;
                }
                
                .update-btn {
                    padding: 8px 16px;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 500;
                    transition: all 0.3s ease;
                }
                
                .update-btn.primary {
                    background: white;
                    color: #4CAF50;
                }
                
                .update-btn.secondary {
                    background: rgba(255,255,255,0.2);
                    color: white;
                }
                
                .update-btn:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                }
                
                .update-icon {
                    margin-right: 8px;
                    font-size: 18px;
                }
                
                @keyframes slideInRight {
                    from {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
                
                @keyframes fadeOut {
                    from {
                        opacity: 1;
                        transform: translateX(0);
                    }
                    to {
                        opacity: 0;
                        transform: translateX(100%);
                    }
                }
                
                .update-notification.fade-out {
                    animation: fadeOut 0.5s ease-out forwards;
                }
            </style>
        `;
        
        document.body.appendChild(updateContainer);
    }

    showUpdateAvailable(info) {
        this.showNotification({
            type: 'info',
            icon: '🔄',
            title: 'Atualização Disponível',
            message: `Nova versão ${info.version} disponível. O download iniciará automaticamente.`,
            persistent: true
        });
    }

    showDownloadProgress(progress) {
        const notification = this.showNotification({
            type: 'info',
            icon: '⬇️',
            title: 'Baixando Atualização',
            message: `Baixando... ${Math.round(progress.percent)}%`,
            persistent: true,
            showProgress: true
        });

        // Atualizar barra de progresso
        const progressFill = notification.querySelector('.progress-fill');
        const progressText = notification.querySelector('.progress-text');
        
        if (progressFill) {
            progressFill.style.width = `${progress.percent}%`;
        }
        
        if (progressText) {
            const speed = this.formatBytes(progress.bytesPerSecond);
            const transferred = this.formatBytes(progress.transferred);
            const total = this.formatBytes(progress.total);
            progressText.textContent = `${transferred} / ${total} (${speed}/s)`;
        }
    }

    showUpdateReady(info) {
        // Remover notificação de download
        this.clearNotifications();
        
        this.showNotification({
            type: 'warning',
            icon: '✅',
            title: 'Atualização Pronta',
            message: `Versão ${info.version} baixada. Reinicie o aplicativo para aplicar.`,
            persistent: true,
            buttons: [
                {
                    text: 'Reiniciar Agora',
                    class: 'primary',
                    action: () => {
                        // O Electron já gerencia o restart
                        this.showNotification({
                            type: 'info',
                            icon: '🔄',
                            title: 'Reiniciando...',
                            message: 'Aplicando atualização...',
                            duration: 2000
                        });
                    }
                },
                {
                    text: 'Mais Tarde',
                    class: 'secondary',
                    action: () => {
                        this.clearNotifications();
                    }
                }
            ]
        });
    }

    showNotification(options) {
        const container = document.getElementById('update-container');
        if (!container) return;

        const notification = document.createElement('div');
        notification.className = `update-notification ${options.type || 'info'}`;
        
        let html = `
            <div class="update-title">
                <span class="update-icon">${options.icon || 'ℹ️'}</span>
                ${options.title}
            </div>
            <div class="update-message">${options.message}</div>
        `;
        
        if (options.showProgress) {
            html += `
                <div class="update-progress">
                    <div class="progress-bar">
                        <div class="progress-fill"></div>
                    </div>
                    <div class="progress-text"></div>
                </div>
            `;
        }
        
        if (options.buttons) {
            html += '<div class="update-buttons">';
            options.buttons.forEach(button => {
                html += `<button class="update-btn ${button.class}" data-action="${button.text}">${button.text}</button>`;
            });
            html += '</div>';
        }
        
        notification.innerHTML = html;
        
        // Adicionar event listeners para botões
        if (options.buttons) {
            options.buttons.forEach(button => {
                const btn = notification.querySelector(`[data-action="${button.text}"]`);
                if (btn && button.action) {
                    btn.addEventListener('click', button.action);
                }
            });
        }
        
        container.appendChild(notification);
        
        // Auto-remover se não for persistente
        if (!options.persistent) {
            setTimeout(() => {
                this.removeNotification(notification);
            }, options.duration || 5000);
        }
        
        this.updateNotification = notification;
        return notification;
    }

    removeNotification(notification) {
        if (notification && notification.parentNode) {
            notification.classList.add('fade-out');
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 500);
        }
    }

    clearNotifications() {
        const container = document.getElementById('update-container');
        if (container) {
            const notifications = container.querySelectorAll('.update-notification');
            notifications.forEach(notification => {
                this.removeNotification(notification);
            });
        }
    }

    async checkAppVersion() {
        try {
            const version = await window.electronAPI.getAppVersion();
            console.log('Versão do aplicativo:', version);
            
            // Mostrar versão no rodapé se existir
            const versionElement = document.querySelector('.app-version');
            if (versionElement) {
                versionElement.textContent = `v${version}`;
            }
        } catch (error) {
            console.error('Erro ao obter versão:', error);
        }
    }

    async manualUpdateCheck() {
        try {
            this.showNotification({
                type: 'info',
                icon: '🔍',
                title: 'Verificando Atualizações',
                message: 'Procurando por novas versões...',
                duration: 3000
            });
            
            await window.electronAPI.checkForUpdates();
        } catch (error) {
            console.error('Erro ao verificar atualizações:', error);
            this.showNotification({
                type: 'warning',
                icon: '⚠️',
                title: 'Erro na Verificação',
                message: 'Não foi possível verificar atualizações.',
                duration: 5000
            });
        }
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

// Inicializar o gerenciador de atualizações quando o DOM estiver pronto
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.updateManager = new UpdateManager();
    });
} else {
    window.updateManager = new UpdateManager();
}

// Expor função global para verificação manual
window.checkForUpdates = () => {
    if (window.updateManager) {
        window.updateManager.manualUpdateCheck();
    }
};