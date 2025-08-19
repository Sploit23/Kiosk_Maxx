let grupos = {};
let fotoSelecionada = null;
let variacoesAtuais = [];
let appVersion = "1.0.0";
let updateAvailable = false;

// Verifica se há atualizações disponíveis
async function verificarAtualizacoes() {
    try {
        // No Electron, podemos obter a versão diretamente da API
        if (window.electronAPI) {
            const electronVersion = await window.electronAPI.getAppVersion();
            appVersion = electronVersion;
        }
        
        const response = await fetch("/api/version");
        if (response.ok) {
            const versionInfo = await response.json();
            
            // Atualiza a versão na interface
            const versionElement = document.getElementById("app-version");
            if (versionElement) {
                versionElement.textContent = `v${appVersion}`;
            }
            
            // Verifica se há atualizações disponíveis
            const updateResponse = await fetch("/api/check-update");
            if (updateResponse.ok) {
                const updateInfo = await updateResponse.json();
                
                if (updateInfo.status === "success" && updateInfo.has_update) {
                    updateAvailable = true;
                    mostrarNotificacaoAtualizacao(updateInfo);
                }
            }
        }
    } catch (error) {
        console.error("Erro ao verificar atualizações:", error);
    }
}

// Mostra notificação de atualização disponível
function mostrarNotificacaoAtualizacao(updateInfo) {
    const notificacao = document.createElement("div");
    notificacao.className = "update-notification";
    
    const titulo = document.createElement("h3");
    titulo.textContent = "Nova versão disponível!";
    
    const versao = document.createElement("p");
    versao.textContent = `Versão ${updateInfo.latest_version} disponível (atual: v${appVersion})`;
    
    const changelog = document.createElement("ul");
    if (updateInfo.changelog && updateInfo.changelog.length > 0) {
        updateInfo.changelog.forEach(item => {
            const li = document.createElement("li");
            li.textContent = item;
            changelog.appendChild(li);
        });
    }
    
    const fecharBtn = document.createElement("button");
    fecharBtn.className = "update-close";
    fecharBtn.textContent = "Fechar";
    fecharBtn.onclick = () => notificacao.remove();
    
    notificacao.appendChild(titulo);
    notificacao.appendChild(versao);
    notificacao.appendChild(changelog);
    notificacao.appendChild(fecharBtn);
    
    document.body.appendChild(notificacao);
}

// Carrega lista de imagens do servidor
async function carregarImagens() {
    // Mostra loading com animação
    const mainDiv = document.getElementById("main");
    const originalContent = mainDiv.innerHTML;
    mainDiv.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Carregando fotos...</p></div>';
    
    try {
        const resp = await fetch("/api/images");
        if (!resp.ok) {
            const erro = await resp.json();
            console.error("Erro ao carregar fotos:", erro);
            
            let mensagemErro = `<div class="error-container">`;
            mensagemErro += `<h2 class="loading">Erro ao carregar fotos</h2>`;
            mensagemErro += `<p class="error-message">${erro.erro || 'Erro desconhecido'}</p>`;
            
            if (erro.solucao) {
                mensagemErro += `<p class="solution-message">${erro.solucao}</p>`;
            }
            
            mensagemErro += `<button class="config-button" onclick="window.location.href='/login'">Ir para Configurações</button>`;
            mensagemErro += `</div>`;
            
            mainDiv.innerHTML = mensagemErro;
            
            // Animação de entrada do erro
            setTimeout(() => {
                const errorContainer = document.querySelector('.error-container');
                if (errorContainer) {
                    errorContainer.style.opacity = '1';
                    errorContainer.style.transform = 'translateY(0)';
                }
            }, 100);
            
            return;
        }
        
        const data = await resp.json();
        grupos = data.grupos || {};
        
        // Restaura o conteúdo original
        mainDiv.innerHTML = originalContent;
        
        // Atualiza a sidebar com as fotos
        atualizarSidebar();
        
        // Se não há fotos selecionadas, seleciona a primeira
        if (!fotoSelecionada && Object.keys(grupos).length > 0) {
            const primeiroGrupo = Object.keys(grupos)[0];
            if (grupos[primeiroGrupo] && grupos[primeiroGrupo].length > 0) {
                selecionarFoto(0, document.querySelector('.photo-item'));
            }
        }
        
    } catch (error) {
        console.error("Erro na requisição:", error);
        
        let mensagemErro = `<div class="error-container">`;
        mensagemErro += `<h2 class="loading">Erro de conexão</h2>`;
        mensagemErro += `<p class="error-message">Não foi possível conectar ao servidor</p>`;
        mensagemErro += `<p class="solution-message">Verifique se o servidor está rodando</p>`;
        mensagemErro += `<button class="config-button" onclick="location.reload()">Tentar Novamente</button>`;
        mensagemErro += `</div>`;
        
        mainDiv.innerHTML = mensagemErro;
    }
}

// Atualiza a sidebar com as fotos
function atualizarSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    
    let html = '';
    
    Object.keys(grupos).forEach(grupo => {
        if (grupos[grupo] && grupos[grupo].length > 0) {
            html += `<div class="grupo-fotos">`;
            html += `<h3 class="grupo-titulo">${grupo}</h3>`;
            
            grupos[grupo].forEach((foto, index) => {
                const isSelected = fotoSelecionada && fotoSelecionada.nome === foto.nome;
                html += `<div class="photo-item ${isSelected ? 'selected' : ''}" onclick="selecionarFoto(${index}, this, '${grupo}')">`;
                html += `<img src="/api/image/${encodeURIComponent(foto.nome)}" alt="${foto.nome}" loading="lazy">`;
                html += `<span class="photo-name">${foto.nome}</span>`;
                html += `</div>`;
            });
            
            html += `</div>`;
        }
    });
    
    if (html === '') {
        html = '<div class="no-photos"><p>Nenhuma foto encontrada</p></div>';
    }
    
    sidebar.innerHTML = html;
}

function selecionarFoto(num, element, grupo = null) {
    // Remove seleção anterior
    document.querySelectorAll('.photo-item').forEach(item => {
        item.classList.remove('selected');
    });
    
    // Adiciona seleção atual
    if (element) {
        element.classList.add('selected');
    }
    
    // Encontra a foto selecionada
    if (grupo && grupos[grupo] && grupos[grupo][num]) {
        fotoSelecionada = grupos[grupo][num];
    } else {
        // Busca em todos os grupos se não especificado
        let fotoEncontrada = null;
        let contador = 0;
        
        for (const g of Object.keys(grupos)) {
            for (const foto of grupos[g]) {
                if (contador === num) {
                    fotoEncontrada = foto;
                    break;
                }
                contador++;
            }
            if (fotoEncontrada) break;
        }
        
        fotoSelecionada = fotoEncontrada;
    }
    
    if (fotoSelecionada) {
        mostrarFotoGrande(fotoSelecionada.nome);
        carregarVariacoes(fotoSelecionada.nome);
    }
}

function mostrarFotoGrande(nome) {
    const mainPhoto = document.getElementById('main-photo');
    if (mainPhoto) {
        mainPhoto.src = `/api/image/${encodeURIComponent(nome)}`;
        mainPhoto.alt = nome;
        
        // Adiciona efeito de fade
        mainPhoto.style.opacity = '0';
        mainPhoto.onload = () => {
            mainPhoto.style.opacity = '1';
        };
    }
    
    // Atualiza informações da foto
    const photoInfo = document.getElementById('photo-info');
    if (photoInfo && fotoSelecionada) {
        photoInfo.innerHTML = `
            <h3>${fotoSelecionada.nome}</h3>
            <p>Tamanho: ${fotoSelecionada.tamanho || 'N/A'}</p>
            <p>Modificado: ${fotoSelecionada.modificado || 'N/A'}</p>
        `;
    }
}

async function carregarVariacoes(nomeImagem) {
    try {
        const response = await fetch(`/api/image-variations/${encodeURIComponent(nomeImagem)}`);
        if (response.ok) {
            const data = await response.json();
            variacoesAtuais = data.variations || [];
            atualizarVariacoes();
        }
    } catch (error) {
        console.error('Erro ao carregar variações:', error);
        variacoesAtuais = [];
        atualizarVariacoes();
    }
}

function atualizarVariacoes() {
    const variationsContainer = document.getElementById('variations-container');
    if (!variationsContainer) return;
    
    if (variacoesAtuais.length === 0) {
        variationsContainer.innerHTML = '<p>Nenhuma variação disponível</p>';
        return;
    }
    
    let html = '<div class="variations-grid">';
    variacoesAtuais.forEach((variacao, index) => {
        html += `<div class="variation-item" onclick="selecionarVariacao(${index})">`;
        html += `<img src="${variacao.url}" alt="${variacao.nome}" loading="lazy">`;
        html += `<span class="variation-name">${variacao.nome}</span>`;
        html += `</div>`;
    });
    html += '</div>';
    
    variationsContainer.innerHTML = html;
}

function selecionarVariacao(index) {
    if (variacoesAtuais[index]) {
        mostrarFotoGrande(variacoesAtuais[index].nome);
    }
}

function mostrarMiniaturas() {
    const mainDiv = document.getElementById('main');
    if (!mainDiv) return;
    
    let html = '<div class="thumbnails-grid">';
    
    Object.keys(grupos).forEach(grupo => {
        if (grupos[grupo] && grupos[grupo].length > 0) {
            html += `<div class="grupo-thumbnails">`;
            html += `<h3>${grupo}</h3>`;
            html += `<div class="thumbnails-row">`;
            
            grupos[grupo].forEach((foto, index) => {
                html += `<div class="thumbnail-item" onclick="selecionarFoto(${index}, this, '${grupo}')">`;
                html += `<img src="/api/image/${encodeURIComponent(foto.nome)}" alt="${foto.nome}" loading="lazy">`;
                html += `<span>${foto.nome}</span>`;
                html += `</div>`;
            });
            
            html += `</div></div>`;
        }
    });
    
    html += '</div>';
    html += '<button class="back-button" onclick="voltarFotoGrande()">Voltar</button>';
    
    mainDiv.innerHTML = html;
}

function voltarFotoGrande() {
    location.reload(); // Simples reload para voltar ao estado inicial
}

// Adiciona informações de versão
// Função removida - versão já existe no HTML

// Gerenciamento de cursor e inatividade
let cursorTimer;
let inactivityTimer;

function resetCursorTimer() {
    clearTimeout(cursorTimer);
    document.body.style.cursor = 'default';
    cursorTimer = setTimeout(() => {
        document.body.style.cursor = 'none';
    }, 3000); // 3 segundos
}

function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        // Volta para a primeira foto após 30 segundos de inatividade
        if (Object.keys(grupos).length > 0) {
            const primeiroGrupo = Object.keys(grupos)[0];
            if (grupos[primeiroGrupo] && grupos[primeiroGrupo].length > 0) {
                selecionarFoto(0, document.querySelector('.photo-item'), primeiroGrupo);
            }
        }
    }, 30000); // 30 segundos
}

// Event listeners para cursor e inatividade
document.addEventListener('mousemove', () => {
    resetCursorTimer();
    resetInactivityTimer();
});

document.addEventListener('click', () => {
    resetCursorTimer();
    resetInactivityTimer();
});

document.addEventListener('touchstart', () => {
    resetCursorTimer();
    resetInactivityTimer();
});

// Sidebar hover behavior
const sidebar = document.getElementById('sidebar');
let sidebarTimeout;

if (sidebar) {
    sidebar.addEventListener('mouseenter', () => {
        clearTimeout(sidebarTimeout);
        sidebar.classList.add('expanded');
    });
    
    sidebar.addEventListener('mouseleave', () => {
        sidebarTimeout = setTimeout(() => {
            sidebar.classList.remove('expanded');
        }, 1000);
    });
}

// Inicializa timers
resetCursorTimer();
resetInactivityTimer();

// Função para adicionar botão de fechar (Electron)
function adicionarBotaoFechar() {
    if (window.electronAPI) {
        const closeButton = document.createElement('button');
        closeButton.className = 'electron-close-btn';
        closeButton.innerHTML = '✕';
        closeButton.title = 'Fechar aplicação';
        closeButton.onclick = () => {
            if (confirm('Deseja realmente fechar a aplicação?')) {
                window.electronAPI.quitApp();
            }
        };
        
        const body = document.body;
        if (body) {
            body.appendChild(closeButton);
        }
    }
}

// Função de fullscreen adaptada para Electron
function toggleFullscreen() {
    if (window.electronAPI) {
        // No Electron, o fullscreen é gerenciado pelo main process
        console.log('Fullscreen gerenciado pelo Electron');
        return;
    }
    
    // Fallback para navegador web
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.error('Erro ao entrar em fullscreen:', err);
        });
    } else {
        document.exitFullscreen().catch(err => {
            console.error('Erro ao sair do fullscreen:', err);
        });
    }
}

// Inicialização quando a janela carrega
window.addEventListener('load', () => {
    console.log('Aplicação carregada');
    
    // Verifica se está rodando no Electron
    if (window.electronAPI) {
        console.log('Rodando no Electron');
        document.body.classList.add('electron-app');
        adicionarBotaoFechar();
    }
    
    // Carrega as imagens
    carregarImagens();
    
    // Verifica atualizações
    verificarAtualizacoes();
    
    // Log de inicialização
    console.log(`Kiosk de Fotos v${appVersion} iniciado`);
});

// Event listener para mudanças de fullscreen
document.addEventListener('fullscreenchange', () => {
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn) {
        if (document.fullscreenElement) {
            fullscreenBtn.textContent = '🗗';
            fullscreenBtn.title = 'Sair do modo tela cheia';
        } else {
            fullscreenBtn.textContent = '🗖';
            fullscreenBtn.title = 'Modo tela cheia';
        }
    }
});

// Inicialização quando o DOM está pronto
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM carregado');
    
    // Configura event listeners para botões
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', toggleFullscreen);
    }
    
    const thumbnailsBtn = document.getElementById('thumbnails-btn');
    if (thumbnailsBtn) {
        thumbnailsBtn.addEventListener('click', mostrarMiniaturas);
    }
});

// Na função onde o botão é criado, adicionar verificação:
addToCartBtn.onclick = (event) => {
    if (!window.cart) {
        console.error('❌ Carrinho não está disponível ainda');
        alert('Aguarde, o sistema está carregando...');
        return;
    }
    window.cart.addItem(photoName, event);
};