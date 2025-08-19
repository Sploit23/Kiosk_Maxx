// Sistema de Atualização
function checkForUpdates() {
    console.log('Verificando atualizações...');
    
    if (window.electronAPI && window.electronAPI.checkForUpdates) {
        window.electronAPI.checkForUpdates()
            .then(result => {
                if (result.updateAvailable) {
                    alert('Nova atualização disponível!');
                } else {
                    alert('Você já está usando a versão mais recente.');
                }
            })
            .catch(error => {
                console.error('Erro ao verificar atualizações:', error);
                alert('Erro ao verificar atualizações.');
            });
    } else {
        alert('Sistema de atualização não disponível.');
    }
}

// Verificar atualizações automaticamente ao carregar
if (window.electronAPI && window.electronAPI.checkForUpdates) {
    // Verificar atualizações após 5 segundos
    setTimeout(() => {
        console.log('Verificação automática de atualizações...');
        window.electronAPI.checkForUpdates().catch(console.error);
    }, 5000);
}