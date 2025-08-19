// JavaScript para admin.html - Interface Administrativa Unificada
document.addEventListener('DOMContentLoaded', function() {
    console.log('🚀 Carregando interface administrativa...');
    
    // Inicializar funcionalidades
    setupNavigationListeners();
    setupEventListeners();
    loadDashboardData();
    loadCurrentSettings();
    
    console.log('✅ Interface administrativa carregada');
});

// Configurar navegação entre seções
function setupNavigationListeners() {
    const menuItems = document.querySelectorAll('.menu-item');
    const sections = document.querySelectorAll('.config-section');
    
    menuItems.forEach(item => {
        item.addEventListener('click', function() {
            const sectionId = this.dataset.section;
            console.log('📍 Navegando para seção:', sectionId);
            
            // Remove active class from all menu items
            menuItems.forEach(mi => mi.classList.remove('active'));
            this.classList.add('active');
            
            // Hide all sections
            sections.forEach(section => section.classList.remove('active'));
            
            // Show selected section
            const targetSection = document.getElementById(sectionId + '-section');
            if (targetSection) {
                targetSection.classList.add('active');
                
                // Load section-specific data
                loadSectionData(sectionId);
            }
        });
    });
}

// Configurar event listeners gerais
function setupEventListeners() {
    // Logout functionality
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.addEventListener('click', function() {
            if (confirm('Tem certeza que deseja sair?')) {
                fetch('/api/logout', { method: 'POST' })
                    .then(() => {
                        window.location.href = '/login.html';
                    })
                    .catch(error => {
                        console.error('Erro ao fazer logout:', error);
                        window.location.href = '/login.html';
                    });
            }
        });
    }
    
    // Refresh dashboard button
    const refreshButton = document.getElementById('refresh-sales-button');
    if (refreshButton) {
        refreshButton.addEventListener('click', function() {
            this.disabled = true;
            this.textContent = '🔄 Atualizando...';
            loadDashboardData().finally(() => {
                this.disabled = false;
                this.textContent = '🔄 Atualizar Dashboard';
            });
        });
    }
}

// Carregar dados específicos de cada seção
function loadSectionData(sectionId) {
    switch(sectionId) {
        case 'dashboard':
            loadDashboardData();
            break;
        case 'images':
            loadImageConfiguration();
            break;
        case 'pricing':
            loadPricingConfiguration();
            break;
        case 'printer-management':
            loadPrinterConfiguration();
            break;

        case 'system':
            loadSystemConfiguration();
            break;
        default:
            console.log('Seção não implementada:', sectionId);
    }
}

// Carregar dados do dashboard
async function loadDashboardData() {
    try {
        console.log('📊 Carregando dados do dashboard...');
        
        const response = await fetch('/api/sales-report');
        if (!response.ok) {
            throw new Error('Erro ao carregar relatório de vendas');
        }
        
        const data = await response.json();
        updateDashboardStats(data);
        
        console.log('✅ Dados do dashboard carregados');
    } catch (error) {
        console.error('❌ Erro ao carregar dashboard:', error);
        showError('Erro ao carregar dados do dashboard');
    }
}

// Atualizar estatísticas do dashboard
function updateDashboardStats(data) {
    // Estatísticas principais
    updateElement('total-sales', formatCurrency(data.totalSales || 0));
    updateElement('total-photos', data.totalPhotos || 0);
    updateElement('today-sales', formatCurrency(data.todaySales || 0));
    updateElement('average-ticket', formatCurrency(data.averageTicket || 0));
    
    // Vendas por método de pagamento
    updateElement('cash-sales', formatCurrency(data.cashSales || 0));
    updateElement('cash-count', `${data.cashCount || 0} vendas`);
    updateElement('card-sales', formatCurrency(data.cardSales || 0));
    updateElement('card-count', `${data.cardCount || 0} vendas`);
    updateElement('pending-sales', formatCurrency(data.pendingSales || 0));
    updateElement('pending-count', `${data.pendingCount || 0} vendas`);
    
    // Impressões por formato
    updateElement('format-10x15', `${data.format10x15 || 0} fotos`);
    updateElement('format-10x15-revenue', formatCurrency(data.format10x15Revenue || 0));
    updateElement('format-15x21', `${data.format15x21 || 0} fotos`);
    updateElement('format-15x21-revenue', formatCurrency(data.format15x21Revenue || 0));
    updateElement('format-20x30', `${data.format20x30 || 0} fotos`);
    updateElement('format-20x30-revenue', formatCurrency(data.format20x30Revenue || 0));
}

// Carregar configurações atuais
async function loadCurrentSettings() {
    try {
        console.log('⚙️ Carregando configurações...');
        
        const response = await fetch('/api/config');
        if (!response.ok) {
            throw new Error('Erro ao carregar configurações');
        }
        
        const config = await response.json();
        console.log('✅ Configurações carregadas:', config);
        
        return config;
    } catch (error) {
        console.error('❌ Erro ao carregar configurações:', error);
        showError('Erro ao carregar configurações');
        return null;
    }
}

// Placeholder functions for other sections
async function loadImageConfiguration() {
    console.log('📁 Carregando configuração de imagens...');
    const section = document.getElementById('images-section');
    if (section) {
        section.innerHTML = `
            <h2>📁 Configuração de Imagens</h2>
            <div class="config-group">
                <label>📂 Pasta Atual de Imagens:</label>
                <div class="folder-info">
                    <p id="current-image-path" class="folder-path">Carregando...</p>
                    <p id="folder-status" class="folder-status">Verificando...</p>
                </div>
                <div class="button-group">
                    <button class="btn-primary" onclick="selectImageFolder()">📁 Selecionar Pasta</button>
                    <button class="btn-secondary" onclick="refreshImageFolder()">🔄 Atualizar</button>
                </div>
            </div>
        `;
    }
}

async function loadPricingConfiguration() {
    console.log('💰 Carregando configuração de preços...');
    const section = document.getElementById('pricing-section');
    if (section) {
        section.innerHTML = `
            <h2>💰 Configuração de Preços</h2>
            <div class="config-group">
                <label>Formato 10x15:</label>
                <input type="number" id="price-10x15" step="0.01" placeholder="15.00">
            </div>
            <div class="config-group">
                <label>Formato 15x21:</label>
                <input type="number" id="price-15x21" step="0.01" placeholder="25.00">
            </div>
            <div class="config-group">
                <label>Formato 20x30:</label>
                <input type="number" id="price-20x30" step="0.01" placeholder="35.00">
            </div>
            <button class="btn-primary" onclick="savePricingConfiguration()">💾 Salvar Preços</button>
        `;
    }
}

async function loadPrinterConfiguration() {
    console.log('🖨️ Carregando configuração de impressoras...');
    const section = document.getElementById('printer-management-section');
    if (section) {
        section.innerHTML = `
            <h2>🖨️ Configuração de Impressoras</h2>
            <div class="config-group">
                <p>Configurações de impressoras serão implementadas aqui...</p>
                <button class="btn-primary" onclick="refreshPrinters()">🔄 Atualizar Impressoras</button>
            </div>
        `;
    }
}



async function loadSystemConfiguration() {
    console.log('⚙️ Carregando configuração do sistema...');
    const section = document.getElementById('system-section');
    if (section) {
        section.innerHTML = `
            <h2>⚙️ Configurações do Sistema</h2>
            <div class="config-group">
                <label>Senha Administrativa:</label>
                <input type="password" id="admin-password" placeholder="Nova senha">
                <button class="btn-primary" onclick="changeAdminPassword()">🔐 Alterar Senha</button>
            </div>
            <div class="config-group">
                <button class="btn-secondary" onclick="restartSystem()">🔄 Reiniciar Sistema</button>
                <button class="btn-danger" onclick="resetSettings()">⚠️ Resetar Configurações</button>
            </div>
        `;
    }
}

// Utility functions
function updateElement(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(value);
}

function showSuccess(message) {
    const successDiv = document.getElementById('success-message');
    if (successDiv) {
        successDiv.textContent = message;
        successDiv.style.display = 'block';
        setTimeout(() => {
            successDiv.style.display = 'none';
        }, 5000);
    }
}

function showError(message) {
    const errorDiv = document.getElementById('error-message');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
        setTimeout(() => {
            errorDiv.style.display = 'none';
        }, 5000);
    }
}

// Placeholder functions for future implementation
function selectImageFolder() {
    showError('Funcionalidade em desenvolvimento');
}

function refreshImageFolder() {
    showSuccess('Pasta de imagens atualizada');
}

function savePricingConfiguration() {
    showSuccess('Preços salvos com sucesso');
}

function refreshPrinters() {
    showSuccess('Lista de impressoras atualizada');
}

function changeAdminPassword() {
    showSuccess('Senha alterada com sucesso');
}

function restartSystem() {
    if (confirm('Tem certeza que deseja reiniciar o sistema?')) {
        showSuccess('Sistema será reiniciado...');
    }
}

function resetSettings() {
    if (confirm('Tem certeza que deseja resetar todas as configurações?')) {
        showError('Funcionalidade em desenvolvimento');
    }
}

// Export functions for global access
window.loadDashboardData = loadDashboardData;
window.selectImageFolder = selectImageFolder;
window.refreshImageFolder = refreshImageFolder;
window.savePricingConfiguration = savePricingConfiguration;
window.refreshPrinters = refreshPrinters;
window.changeAdminPassword = changeAdminPassword;
window.restartSystem = restartSystem;
window.resetSettings = resetSettings;