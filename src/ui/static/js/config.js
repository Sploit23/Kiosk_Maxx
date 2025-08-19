// JavaScript para config.html
document.addEventListener('DOMContentLoaded', function() {
    // Mostrar dashboard por padrão
    setTimeout(() => {
        showSection('dashboard');
    }, 100);
    
    loadCurrentVersion();
    loadSalesReports();
    loadPrinterConfiguration();
    loadCurrentSettings();
    setupEventListeners();
});

// Configurar event listeners
function setupEventListeners() {
    // Event listeners para o menu lateral
    document.querySelectorAll('.menu-item').forEach(item => {
        item.addEventListener('click', function() {
            const section = this.getAttribute('data-section');
            console.log('Clicou na seção:', section);
            showSection(section);
            
            // Atualizar item ativo no menu
            document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('active'));
            this.classList.add('active');
        });
    });
    
    // Botão de salvar configurações de imagem - VERIFICAR SE EXISTE
    const saveButton = document.getElementById('save-button');
    if (saveButton) {
        saveButton.addEventListener('click', saveImageConfig);
    } else {
        console.warn('⚠️ Botão save-button não encontrado');
    }
    
    // Botão de logout - VERIFICAR SE EXISTE
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.addEventListener('click', async () => {
            if (confirm('Tem certeza que deseja sair da área administrativa?')) {
                try {
                    await fetch('/api/logout', { method: 'POST' });
                    window.location.href = '/login.html';
                } catch (error) {
                    console.error('Erro ao fazer logout:', error);
                    window.location.href = '/login.html';
                }
            }
        });
    } else {
        console.warn('⚠️ Botão logout-button não encontrado');
    }
    
    // Event listeners adicionais
    const refreshButton = document.getElementById('refresh-sales-button');
    if (refreshButton) {
        refreshButton.addEventListener('click', loadSalesReports);
    }
    
    const checkUpdatesButton = document.getElementById('check-updates-button');
    if (checkUpdatesButton) {
        checkUpdatesButton.addEventListener('click', checkForUpdates);
    }
    
    // Event listeners para configuração de impressoras
    const savePrinterButton = document.getElementById('save-printer-config-button');
    console.log('🔍 Botão de salvar encontrado:', savePrinterButton);
    
    if (savePrinterButton) {
        console.log('✅ Adicionando event listener ao botão de salvar');
        savePrinterButton.addEventListener('click', function(event) {
            console.log('🖱️ Botão de salvar clicado!');
            event.preventDefault();
            savePrinterConfiguration();
        });
    } else {
        console.error('❌ Botão save-printer-config-button não encontrado!');
    }
    
    const testPrintButton = document.getElementById('test-print-button');
    if (testPrintButton) {
        testPrintButton.addEventListener('click', testPrint);
    }
    
    const refreshPrintersButton = document.getElementById('refresh-printers-button');
    if (refreshPrintersButton) {
        refreshPrintersButton.addEventListener('click', async function() {
            this.disabled = true;
            this.textContent = '🔄 Atualizando...';
            await loadPrinterConfiguration();
            this.disabled = false;
            this.textContent = '🔄 Atualizar Lista';
        });
    }
}

// Função para mostrar seção específica (CORRIGIDA)
function showSection(sectionName) {
    console.log('Mostrando seção:', sectionName); // Debug
    
    // Ocultar todas as seções
    document.querySelectorAll('.config-section').forEach(section => {
        section.classList.remove('active');
        section.style.display = 'none';
    });
    
    // Mostrar seção selecionada
    const targetSection = document.getElementById(sectionName + '-section');
    console.log('Seção encontrada:', targetSection); // Debug
    
    if (targetSection) {
        targetSection.style.display = 'block';
        targetSection.classList.add('active');
        console.log('Seção ativada:', sectionName); // Debug
        
        // Carregar dados específicos da seção
        if (sectionName === 'images') {
            loadImageConfig();

        }
    } else {
        console.error('Seção não encontrada:', sectionName + '-section');
    }
    
    // Marcar item do menu como ativo
    document.querySelectorAll('.menu-item').forEach(item => {
        item.classList.remove('active');
    });
    
    const menuItem = document.querySelector(`[data-section="${sectionName}"]`);
    if (menuItem) {
        menuItem.classList.add('active');
    }
}

// Funções do Electron
async function restartApp() {
    if (window.electronAPI && window.electronAPI.restartApp) {
        if (confirm('Deseja realmente reiniciar a aplicação?')) {
            try {
                await window.electronAPI.restartApp();
            } catch (error) {
                console.error('Erro ao reiniciar:', error);
                showError('Erro ao reiniciar a aplicação.');
            }
        }
    } else {
        showError('Funcionalidade disponível apenas no Electron');
    }
}

async function showUserDataPath() {
    if (window.electronAPI && window.electronAPI.showUserDataPath) {
        try {
            const path = await window.electronAPI.showUserDataPath();
            alert(`Pasta de dados: ${path}`);
        } catch (error) {
            console.error('Erro ao mostrar pasta:', error);
            showError('Erro ao abrir pasta de dados.');
        }
    } else {
        showError('Funcionalidade disponível apenas no Electron');
    }
}

async function toggleDevTools() {
    if (window.electronAPI && window.electronAPI.toggleDevTools) {
        try {
            await window.electronAPI.toggleDevTools();
        } catch (error) {
            console.error('Erro ao abrir Dev Tools:', error);
        }
    } else {
        showError('Dev Tools - Funcionalidade disponível apenas em desenvolvimento');
    }
}

async function closeApp() {
    if (window.electronAPI && window.electronAPI.quitApp) {
        if (confirm('Deseja realmente fechar a aplicação?')) {
            try {
                await window.electronAPI.quitApp();
            } catch (error) {
                console.error('Erro ao fechar:', error);
                showError('Erro ao fechar a aplicação.');
            }
        }
    } else {
        showError('Funcionalidade disponível apenas no Electron');
    }
}

async function selectImagePath() {
    if (window.electronAPI && window.electronAPI.selectDirectory) {
        try {
            const selectedPath = await window.electronAPI.selectDirectory();
            if (selectedPath) {
                document.getElementById('image-path').value = selectedPath;
                showSuccess('Pasta selecionada: ' + selectedPath);
            }
        } catch (error) {
            console.error('Erro ao selecionar pasta:', error);
            showError('Erro ao selecionar pasta.');
        }
    } else {
        showError('Seleção de pasta disponível apenas no Electron');
    }
}

// Carregar versão atual
async function loadCurrentVersion() {
    if (window.electronAPI && window.electronAPI.getAppVersion) {
        try {
            const version = await window.electronAPI.getAppVersion();
            const versionElement = document.getElementById('current-version');
            if (versionElement) {
                versionElement.textContent = version;
            }
        } catch (error) {
            const versionElement = document.getElementById('current-version');
            if (versionElement) {
                versionElement.textContent = 'Erro ao carregar';
            }
        }
    } else {
        const versionElement = document.getElementById('current-version');
        if (versionElement) {
            versionElement.textContent = '1.0.0 (Web)';
        }
    }
}

// Verificar atualizações
async function checkForUpdates() {
    if (window.electronAPI && window.electronAPI.checkForUpdates) {
        const button = document.getElementById('check-updates-button');
        if (button) {
            button.disabled = true;
            button.textContent = '🔄 Verificando...';
            
            try {
                await window.electronAPI.checkForUpdates();
                showSuccess('Verificação de atualizações iniciada!');
            } catch (error) {
                console.error('Erro ao verificar atualizações:', error);
                showError('Erro ao verificar atualizações.');
            } finally {
                button.disabled = false;
                button.textContent = '🔍 Verificar Atualizações';
            }
        }
    } else {
        showError('Verificação de atualizações disponível apenas no Electron');
    }
}

// Carregar configurações atuais
async function loadCurrentSettings() {
    try {
        const response = await fetch('/api/config/current');
        if (response.ok) {
            const config = await response.json();
            if (config.image_path) {
                const imagePathInput = document.getElementById('image-path');
                if (imagePathInput) {
                    imagePathInput.value = config.image_path;
                }
            }
        }
    } catch (error) {
        console.error('Erro ao carregar configurações:', error);
    }
}

// Salvar configurações de imagem (CORRIGIDO)
async function saveImageConfig() {
    const imagePath = document.getElementById('image-path').value.trim();
    
    if (!imagePath) {
        showError('Por favor, informe o caminho da pasta de imagens.');
        return;
    }
    
    const button = document.getElementById('save-button');
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '💾 Salvando...';
    
    try {
        // Tentar múltiplas rotas para compatibilidade
        let response;
        
        // Primeira tentativa: rota original
        try {
            response = await fetch('/api/image-config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    image_path: imagePath
                })
            });
        } catch (error) {
            console.log('Tentativa 1 falhou, tentando rota alternativa...');
            
            // Segunda tentativa: rota alternativa
            response = await fetch('/api/config/update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    image_path: imagePath
                })
            });
        }
        
        const result = await response.json();
        
        if (response.ok) {
            showSuccess('Configurações salvas com sucesso!');
        } else {
            showError(result.message || 'Erro ao salvar configurações.');
        }
    } catch (error) {
        console.error('Erro ao salvar configurações:', error);
        showError('Erro ao comunicar com o servidor. Verifique se o servidor está rodando.');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

// Carregar relatórios de vendas
async function loadSalesReports() {
    try {
        const response = await fetch('/api/sales/reports');
        if (response.ok) {
            const data = await response.json();
            updateSalesStats(data);
        }
    } catch (error) {
        console.error('Erro ao carregar relatórios:', error);
    }
}

// Atualizar estatísticas de vendas
function updateSalesStats(data) {
    const elements = {
        'total-sales': `R$ ${(data.total_sales || 0).toFixed(2)}`,
        'total-photos': data.total_photos || 0,
        'today-sales': `R$ ${(data.today_sales || 0).toFixed(2)}`,
        'average-ticket': `R$ ${(data.average_ticket || 0).toFixed(2)}`
    };
    
    Object.entries(elements).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value;
        }
    });
}

// Carregar configuração de impressoras
async function loadPrinterConfiguration() {
    try {
        // Carrega impressoras disponíveis
        const printersResponse = await fetch('/api/printers');
        if (printersResponse.ok) {
            const printers = await printersResponse.json();
            console.log('Impressoras carregadas:', printers);
            
            // Aguarda um pouco para garantir que os elementos estejam no DOM
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Popula todos os seletores de impressora
            const printerSelects = document.querySelectorAll('.printer-select');
            
            printerSelects.forEach(select => {
                select.innerHTML = '<option value="">Selecione uma impressora</option>';
                
                if (printers && printers.length > 0) {
                    printers.forEach(printer => {
                        const option = document.createElement('option');
                        option.value = printer.name;
                        option.textContent = `${printer.name} (${printer.status || 'Desconhecido'})`;
                        select.appendChild(option);
                    });
                } else {
                    const option = document.createElement('option');
                    option.value = '';
                    option.textContent = 'Nenhuma impressora encontrada';
                    select.appendChild(option);
                }
                
                // Adiciona listener para atualizar status
                select.addEventListener('change', function() {
                    const format = this.id.replace('printer-', '');
                    
                    if (this.value) {
                        updateFormatStatus(format, this.value);
                    } else {
                        updateFormatStatus(format, '');
                    }
                    updateConfigSummary();
                });
            });
            

        } else {
            console.error('Erro ao carregar impressoras:', printersResponse.status);
        }
        
        // Carrega configuração atual
        const configResponse = await fetch('/api/printer-config');
        if (configResponse.ok) {
            const config = await configResponse.json();
            
            // Configura impressoras por formato
            const formats = ['10x15', '15x20', 'bolas'];
            formats.forEach(format => {
                const printerSelect = document.getElementById(`printer-${format}`);
                if (config.format_mappings && config.format_mappings[format]) {
                    const mapping = config.format_mappings[format];
                    
                    if (mapping.printer && printerSelect) {
                        printerSelect.value = mapping.printer;
                        updateFormatStatus(format, mapping.printer);
                    }
                }
            });
            
            // Atualizar resumo da configuração após carregar
            setTimeout(() => {
                updateConfigSummary();
            }, 1000);
        }
    } catch (error) {
        console.error('Erro ao carregar configuração de impressoras:', error);
        showError('Erro ao carregar configuração de impressoras.');
    }
}





// Função para atualizar o status visual de um formato
function updateFormatStatus(format, printerName) {
    const statusElement = document.getElementById(`status-${format}`);
    if (!statusElement) return;
    
    const indicator = statusElement.querySelector('div');
    const text = statusElement.querySelector('span');
    
    if (!indicator || !text) return;
    
    if (printerName) {
        // Impressora configurada
        indicator.style.backgroundColor = '#28a745'; // Verde
        text.textContent = 'Configurado';
        text.style.color = '#28a745';
    } else {
        // Não configurado
        indicator.style.backgroundColor = '#6c757d'; // Cinza
        text.textContent = 'Não configurado';
        text.style.color = '#6c757d';
    }
}

function updateConfigSummary() {
    const summaryDiv = document.getElementById('config-summary-content');
    const formats = ['10x15', '15x20', 'bolas'];
    const formatNames = {
        '10x15': '10x15 cm',
        '15x20': '15x20 cm',
        'bolas': 'Bolas'
    };
    
    let summaryHTML = '';
    let configuredCount = 0;
    
    // Seção de configurações atuais na interface
    summaryHTML += `
        <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 15px; border-left: 4px solid #007bff;">
            <h5 style="margin: 0 0 10px 0; color: #007bff;">🖥️ Configurações Atuais na Interface</h5>
    `;
    
    formats.forEach(format => {
        const printerSelect = document.getElementById(`printer-${format}`);
        
        if (printerSelect && printerSelect.value) {
            configuredCount++;
            summaryHTML += `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid #dee2e6;">
                    <div><strong>${formatNames[format]}</strong></div>
                    <div style="text-align: right; font-size: 0.9em;">
                        <div>${printerSelect.value}</div>
                    </div>
                </div>
            `;
        } else {
            summaryHTML += `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid #dee2e6;">
                    <div><strong>${formatNames[format]}</strong></div>
                    <div style="text-align: right; font-size: 0.9em; color: #dc3545;">❌ Não configurado</div>
                </div>
            `;
        }
    });
    
    summaryHTML += `</div>`;
    
    // Seção de configurações salvas no sistema
    summaryHTML += `
        <div style="background: #e8f5e8; padding: 15px; border-radius: 5px; margin-bottom: 15px; border-left: 4px solid #28a745;">
            <h5 style="margin: 0 0 10px 0; color: #28a745;">💾 Configurações Salvas no Sistema</h5>
            <div id="saved-config-status">🔄 Carregando...</div>
        </div>
    `;
    
    // Seção de status da persistência
    summaryHTML += `
        <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin-bottom: 15px; border-left: 4px solid #ffc107;">
            <h5 style="margin: 0 0 10px 0; color: #856404;">🔄 Status da Persistência</h5>
            <div id="persistence-status">
                <div>📡 Endpoint: /api/printer-config</div>
                <div>🕐 Última tentativa de salvamento: <span id="last-save-attempt">Nunca</span></div>
                <div>✅ Último salvamento bem-sucedido: <span id="last-save-success">Nunca</span></div>
                <div>❌ Último erro: <span id="last-save-error">Nenhum</span></div>
            </div>
        </div>
    `;
    
    if (configuredCount === 0) {
        summaryHTML = `
            <div style="text-align: center; padding: 20px; color: #6c757d;">
                <p>Configure as impressoras para cada formato para ver o resumo aqui.</p>
            </div>
        ` + summaryHTML;
    }
    
    summaryDiv.innerHTML = summaryHTML;
    
    // Carregar e exibir configurações salvas
    loadSavedConfigStatus();
}

// Nova função para carregar status das configurações salvas
async function loadSavedConfigStatus() {
    const savedConfigDiv = document.getElementById('saved-config-status');
    
    if (!savedConfigDiv) {
        console.log('⚠️ Elemento saved-config-status não encontrado');
        return;
    }
    
    try {
        console.log('🔄 Carregando configurações salvas do servidor...');
        
        const response = await fetch('/api/printer-config');
        console.log('📡 Resposta do servidor para GET:', response.status, response.statusText);
        
        if (response.ok) {
            const savedConfig = await response.json();
            console.log('📋 Configurações carregadas:', savedConfig);
            
            let savedHTML = '';
            
            if (savedConfig.format_mappings && Object.keys(savedConfig.format_mappings).length > 0) {
                const formatNames = {
                    '10x15': '10x15 cm',
                    '15x20': '15x20 cm',
                    'bolas': 'Bolas'
                };
                
                Object.keys(savedConfig.format_mappings).forEach(format => {
                    const config = savedConfig.format_mappings[format];
                    savedHTML += `
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid #c3e6cb;">
                            <div><strong>${formatNames[format] || format}</strong></div>
                            <div style="text-align: right; font-size: 0.9em;">
                                <div>${config.printer}</div>
                            </div>
                        </div>
                    `;
                });
                
                if (savedConfig.user_preferences && savedConfig.user_preferences.last_session_date) {
                    const lastSave = new Date(savedConfig.user_preferences.last_session_date);
                    savedHTML += `
                        <div style="margin-top: 10px; font-size: 0.8em; color: #6c757d; text-align: center;">
                            📅 Última atualização: ${lastSave.toLocaleString('pt-BR')}
                        </div>
                    `;
                }
            } else {
                savedHTML = '<div style="color: #dc3545; text-align: center;">❌ Nenhuma configuração salva encontrada</div>';
            }
            
            savedConfigDiv.innerHTML = savedHTML;
            
        } else {
            savedConfigDiv.innerHTML = '<div style="color: #dc3545; text-align: center;">❌ Erro ao carregar configurações salvas</div>';
        }
    } catch (error) {
        console.error('❌ Erro ao carregar configurações:', error);
        savedConfigDiv.innerHTML = `<div style="color: #dc3545; text-align: center;">❌ Erro de conexão: ${error.message}</div>`;
    }
}

async function savePrinterConfiguration() {
    console.log('🚀 FUNÇÃO savePrinterConfiguration CHAMADA!'); // Debug principal
    
    const button = document.getElementById('save-printer-config-button');
    if (!button) {
        console.error('❌ Botão não encontrado na função savePrinterConfiguration!');
        return;
    }
    
    const originalText = button.textContent;
    
    console.log('🔄 Iniciando salvamento das configurações...');
    
    // Feedback visual imediato
    button.disabled = true;
    button.textContent = '💾 Salvando...';
    button.style.background = '#ffc107';
    
    // Limpar mensagens anteriores
    const successElement = document.getElementById('success-message');
    const errorElement = document.getElementById('error-message');
    if (successElement) successElement.style.display = 'none';
    if (errorElement) errorElement.style.display = 'none';
    
    try {
        const formats = ['10x15', '15x20', 'bolas'];
        const formatMappings = {};
        const availablePrinters = {};
        let hasValidConfig = false;
        let defaultPrinter = 'FUJIFILM ASK-300';
        
        console.log('📋 Coletando configurações das impressoras...');
        
        // Validar e coletar configurações de cada formato
        for (const format of formats) {
            const printerSelect = document.getElementById(`printer-${format}`);
            
            console.log(`🔍 Verificando formato ${format}:`, {
                printer: printerSelect?.value
            });
            
            if (printerSelect && printerSelect.value) {
                const javaClassMap = {
                    '10x15': 'ImprimirFoto10x15ASK300',
                    '15x20': 'ImprimirFoto15x20ASK300',
                    'bolas': 'ImprimirFotoBolasASK300'
                };
                
                formatMappings[format] = {
                    printer: printerSelect.value,
                    java_class: javaClassMap[format] || `ImprimirFoto${format}ASK300`
                };
                
                // Definir impressora padrão
                if (!hasValidConfig) {
                    defaultPrinter = printerSelect.value;
                }
                
                // Adicionar impressora à lista de impressoras disponíveis
                if (!availablePrinters[printerSelect.value]) {
                    availablePrinters[printerSelect.value] = {
                        name: printerSelect.value,
                        devmode_path: `spool_devmodes/${printerSelect.value.replace(/[^a-zA-Z0-9]/g, '_')}_devmode.bin`,
                        status: 'online'
                    };
                }
                
                hasValidConfig = true;
                console.log(`✅ Formato ${format} configurado:`, formatMappings[format]);
            } else {
                console.log(`⚠️ Formato ${format} não configurado`);
            }
        }
        
        if (!hasValidConfig) {
            throw new Error('Por favor, configure pelo menos um formato com impressora.');
        }
        
        // Configuração completa seguindo a estrutura correta
        const config = {
            last_used_printer: defaultPrinter,
            user_preferences: {
                default_printer: defaultPrinter,
                default_format: '10x15',
                auto_print_copies: 1,
                last_session_date: new Date().toISOString()
            },
            format_mappings: formatMappings,
            available_printers: availablePrinters,
            default_settings: {
                orientation: 'landscape',
                margins: 0,
                scale: 'fit',
                quality: 'high'
            }
        };
        
        console.log('📤 Enviando configuração para o servidor:', config);
        
        // Fazer a requisição para salvar
        const response = await fetch('/api/printer-config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });
        
        console.log('📡 Resposta do servidor:', {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok
        });
        
        if (response.ok) {
            const result = await response.json();
            console.log('✅ Configuração salva com sucesso:', result);
            
            // Feedback de sucesso
            button.style.background = '#28a745';
            button.textContent = '✅ Salvo!';
            
            // Mostrar mensagem de sucesso
            showSuccess(`🎉 Configurações salvas com sucesso! ${Object.keys(formatMappings).length} formato(s) configurado(s).`);
            
            // Atualizar o resumo para mostrar as novas configurações
            setTimeout(() => {
                updateConfigSummary();
                loadSavedConfigStatus();
            }, 500);
            
            // Configurações atualizadas com sucesso
            
            // Atualizar ConfigManager se disponível
            if (window.configManager) {
                window.configManager.config = config;
                console.log('🔄 ConfigManager atualizado com nova configuração');
            }
            
            // Disparar evento para atualizar resumo da impressora
            window.dispatchEvent(new CustomEvent('printerConfigChanged', {
                detail: { config: config }
            }));
            
            console.log('📡 Evento printerConfigChanged disparado');
            
        } else {
            let errorMessage;
            try {
                const result = await response.json();
                errorMessage = result.error || result.message || 'Erro desconhecido';
            } catch (e) {
                errorMessage = `Erro HTTP ${response.status}: ${response.statusText}`;
            }
            throw new Error(errorMessage);
        }
        
    } catch (error) {
        console.error('❌ Erro ao salvar configuração:', error);
        
        // Feedback de erro
        button.style.background = '#dc3545';
        button.textContent = '❌ Erro!';
        
        // Mostrar mensagem de erro
        showError(`💥 Erro ao salvar: ${error.message}`);
        
    } finally {
        // Restaurar botão após 3 segundos
        setTimeout(() => {
            button.disabled = false;
            button.textContent = originalText;
            button.style.background = '';
        }, 3000);
    }
}

async function testPrint() {
    const button = document.getElementById('test-print-button');
    button.disabled = true;
    button.textContent = '🖨️ Testando...';
    
    try {
        const response = await fetch('/api/test-print', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                test_type: 'configuration_test'
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            showSuccess('Teste de impressão enviado com sucesso!');
        } else {
            showError(result.error || 'Erro no teste de impressão.');
        }
    } catch (error) {
        console.error('Erro no teste de impressão:', error);
        showError('Erro ao comunicar com o servidor.');
    } finally {
        button.disabled = false;
        button.textContent = '🖨️ Teste de Impressão';
    }
}

// Funções de mensagens (corrigidas)
function showSuccess(message) {
    console.log('✅ Mostrando mensagem de sucesso:', message);
    
    // Tentar usar o elemento existente
    let successElement = document.getElementById('success-message');
    
    if (!successElement) {
        console.log('⚠️ Elemento success-message não encontrado, criando um novo');
        // Criar elemento se não existir
        successElement = document.createElement('div');
        successElement.id = 'success-message';
        successElement.className = 'success-message';
        
        // Inserir no topo da página de configuração
        const configContainer = document.querySelector('.config-container') || document.body;
        configContainer.insertBefore(successElement, configContainer.firstChild);
    }
    
    // Aplicar estilos e conteúdo
    successElement.innerHTML = `<strong>✅ ${message}</strong>`;
    successElement.style.display = 'block';
    successElement.style.opacity = '1';
    successElement.style.background = '#d4edda';
    successElement.style.color = '#155724';
    successElement.style.border = '1px solid #c3e6cb';
    successElement.style.padding = '15px';
    successElement.style.borderRadius = '5px';
    successElement.style.margin = '10px 0';
    successElement.style.fontSize = '14px';
    successElement.style.fontWeight = 'bold';
    successElement.style.textAlign = 'center';
    successElement.style.transition = 'opacity 0.3s ease';
    
    // Scroll para a mensagem
    successElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    
    // Auto-hide após 5 segundos
    setTimeout(() => {
        if (successElement && successElement.style.display !== 'none') {
            successElement.style.opacity = '0';
            setTimeout(() => {
                successElement.style.display = 'none';
            }, 300);
        }
    }, 5000);
}

function showError(message) {
    console.log('❌ Mostrando mensagem de erro:', message);
    
    // Tentar usar o elemento existente
    let errorElement = document.getElementById('error-message');
    
    if (!errorElement) {
        console.log('⚠️ Elemento error-message não encontrado, criando um novo');
        // Criar elemento se não existir
        errorElement = document.createElement('div');
        errorElement.id = 'error-message';
        errorElement.className = 'error-message';
        
        // Inserir no topo da página de configuração
        const configContainer = document.querySelector('.config-container') || document.body;
        configContainer.insertBefore(errorElement, configContainer.firstChild);
    }
    
    // Aplicar estilos e conteúdo
    errorElement.innerHTML = `<strong>❌ ${message}</strong>`;
    errorElement.style.display = 'block';
    errorElement.style.opacity = '1';
    errorElement.style.background = '#f8d7da';
    errorElement.style.color = '#721c24';
    errorElement.style.border = '1px solid #f5c6cb';
    errorElement.style.padding = '15px';
    errorElement.style.borderRadius = '5px';
    errorElement.style.margin = '10px 0';
    errorElement.style.fontSize = '14px';
    errorElement.style.fontWeight = 'bold';
    errorElement.style.textAlign = 'center';
    errorElement.style.transition = 'opacity 0.3s ease';
    
    // Scroll para a mensagem
    errorElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    
    // Auto-hide após 7 segundos
    setTimeout(() => {
        if (errorElement && errorElement.style.display !== 'none') {
            errorElement.style.opacity = '0';
            setTimeout(() => {
                errorElement.style.display = 'none';
            }, 300);
        }
    }, 7000);
}

// Adicionar função para seleção de pasta (adicionar no final do arquivo)

// Função para selecionar pasta de imagens (Electron)
async function selectImageFolder() {
    try {
        if (typeof window.electronAPI !== 'undefined') {
            const result = await window.electronAPI.selectDirectory();
            if (result && !result.canceled && result.filePaths.length > 0) {
                const selectedPath = result.filePaths[0];
                // Atualizar a interface para mostrar a nova pasta selecionada
                document.getElementById('current-image-path').textContent = selectedPath;
                document.getElementById('folder-status').textContent = 'Nova pasta selecionada - clique em "Salvar Configuração" para aplicar';
                document.getElementById('folder-status').className = 'folder-status warning';
                
                // Mostrar o botão de salvar
                const saveButton = document.getElementById('save-image-config-button');
                if (saveButton) {
                    saveButton.style.display = 'inline-block';
                    saveButton.setAttribute('data-folder-path', selectedPath);
                }
            }
        } else {
            showError('Seleção de pasta disponível apenas no modo desktop');
        }
    } catch (error) {
        console.error('Erro ao selecionar pasta:', error);
        showError('Erro ao selecionar pasta de imagens');
    }
}

// Nova função para salvar configuração de imagem com feedback visual
async function saveImageConfiguration() {
    const saveButton = document.getElementById('save-image-config-button');
    const folderPath = saveButton.getAttribute('data-folder-path');
    
    if (!folderPath) {
        showError('Nenhuma pasta foi selecionada');
        return;
    }
    
    try {
        // Mostrar feedback visual de salvamento
        saveButton.disabled = true;
        saveButton.classList.add('saving');
        saveButton.innerHTML = '💾 Salvando...';
        
        const response = await fetch('/api/select-image-folder', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ folder_path: folderPath })
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Feedback de sucesso
            saveButton.innerHTML = '✅ Salvo!';
            saveButton.classList.remove('saving');
            
            // Atualizar status
            document.getElementById('folder-status').textContent = 'Configuração salva com sucesso!';
            document.getElementById('folder-status').className = 'folder-status success';
            
            showSuccess(`Pasta de imagens configurada: ${result.folder_path}`);
            
            // Recarregar configuração de imagens
            await loadImageConfig();
            
            // Ocultar botão após 2 segundos
            setTimeout(() => {
                saveButton.style.display = 'none';
                saveButton.innerHTML = '💾 Salvar Configuração';
                saveButton.disabled = false;
            }, 2000);
            
        } else {
            // Feedback de erro
            saveButton.innerHTML = '❌ Erro';
            saveButton.classList.remove('saving');
            saveButton.disabled = false;
            
            document.getElementById('folder-status').textContent = result.error || 'Erro ao salvar configuração';
            document.getElementById('folder-status').className = 'folder-status error';
            
            showError(result.error || 'Erro ao salvar configuração de pasta');
            
            // Restaurar botão após 2 segundos
            setTimeout(() => {
                saveButton.innerHTML = '💾 Salvar Configuração';
            }, 2000);
        }
    } catch (error) {
        console.error('Erro ao salvar configuração:', error);
        
        // Feedback de erro de conexão
        saveButton.innerHTML = '❌ Erro de Conexão';
        saveButton.classList.remove('saving');
        saveButton.disabled = false;
        
        document.getElementById('folder-status').textContent = 'Erro de comunicação com o servidor';
        document.getElementById('folder-status').className = 'folder-status error';
        
        showError('Erro ao comunicar com o servidor');
        
        // Restaurar botão após 2 segundos
        setTimeout(() => {
            saveButton.innerHTML = '💾 Salvar Configuração';
        }, 2000);
    }
}

// Função para atualizar pasta de imagens (mantida para compatibilidade)
async function updateImageFolder(folderPath) {
    try {
        const response = await fetch('/api/select-image-folder', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ folder_path: folderPath })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess(`Pasta de imagens atualizada: ${result.folder_path}`);
            // Recarregar configuração de imagens
            await loadImageConfig();
        } else {
            showError(result.error || 'Erro ao atualizar pasta de imagens');
        }
    } catch (error) {
        console.error('Erro ao atualizar pasta:', error);
        showError('Erro ao comunicar com o servidor');
    }
}

// Função para carregar configuração atual de imagens
async function loadImageConfig() {
    try {
        const response = await fetch('/api/current-image-folder');
        const data = await response.json();
        
        const pathElement = document.getElementById('current-image-path');
        const statusElement = document.getElementById('folder-status');
        const foldersElement = document.getElementById('available-folders');
        const saveButton = document.getElementById('save-image-config-button');
        
        if (pathElement) {
            pathElement.textContent = data.current_path || 'Nenhuma pasta configurada';
        }
        
        if (statusElement) {
            if (data.current_path && data.exists) {
                statusElement.textContent = '✅ Pasta configurada e acessível';
                statusElement.className = 'folder-status success';
            } else if (data.current_path && !data.exists) {
                statusElement.textContent = '❌ Pasta configurada mas não encontrada';
                statusElement.className = 'folder-status error';
            } else {
                statusElement.textContent = '⚠️ Nenhuma pasta foi configurada';
                statusElement.className = 'folder-status warning';
            }
        }
        
        if (foldersElement) {
            if (data.available_date_folders && data.available_date_folders.length > 0) {
                const folderList = data.available_date_folders.map(folder => {
                    // Converter DDMMAAAA para formato legível
                    const day = folder.substring(0, 2);
                    const month = folder.substring(2, 4);
                    const year = folder.substring(4, 8);
                    return `<span class="date-folder">${folder} (${day}/${month}/${year})</span>`;
                }).join(', ');
                foldersElement.innerHTML = `<strong>📅 Pastas de data encontradas:</strong><br>${folderList}`;
            } else if (data.current_path && data.exists) {
                foldersElement.innerHTML = '<em>⚠️ Nenhuma pasta de data encontrada. Crie pastas no formato DDMMAAAA (ex: 14082025)</em>';
            } else {
                foldersElement.innerHTML = '<em>Selecione uma pasta de imagens para ver as pastas de data disponíveis</em>';
            }
        }
        
        // Ocultar botão de salvar se não há pasta pendente
        if (saveButton && !saveButton.getAttribute('data-folder-path')) {
            saveButton.style.display = 'none';
        }
        
    } catch (error) {
        console.error('Erro ao carregar configuração de imagens:', error);
        const statusElement = document.getElementById('folder-status');
        if (statusElement) {
            statusElement.textContent = 'Erro ao carregar configuração';
            statusElement.className = 'folder-status error';
        }
    }
}



// Inicializar quando a página carregar
document.addEventListener('DOMContentLoaded', () => {
    loadImageConfig();
});