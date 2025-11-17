#!/usr/bin/env python3
"""
Mover por Data - Edição Natalina 🎄
- Exibe seleção de pastas apenas na primeira execução.
- Salva configurações em config.json e lê automaticamente depois.
- Move arquivos da subpasta com data atual (DDMMYYYY/DDMMYY) da pasta 1 para uma subpasta equivalente na pasta 2.
- Interface com tema natalino e barra de progresso.

Dependências:
  pip install pygame
"""

import os
import sys
import json
import shutil
import threading
import time
from datetime import datetime
import pygame
from pygame.locals import *
import tkinter as tk
from tkinter import filedialog, messagebox

CONFIG_FILE = 'config.json'

# ---------- Funções utilitárias ----------

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_config(data):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def choose_folder_dialog(prompt='Selecione uma pasta'):
    root = tk.Tk()
    root.withdraw()
    folder = filedialog.askdirectory(title=prompt)
    root.destroy()
    return folder

def find_today_subfolder(src):
    """
    Procura dentro da pasta 'src' por uma subpasta cujo nome corresponde
    à data atual em qualquer formato comum:
      DDMMYYYY, DDMMYY, YYMMDD, YYYYMMDD.
    """
    today = datetime.now()
    possible_formats = [
        today.strftime('%d%m%Y'),
        today.strftime('%d%m%y'),
        today.strftime('%y%m%d'),
        today.strftime('%Y%m%d'),
    ]

    try:
        for name in os.listdir(src):
            full = os.path.join(src, name)
            if os.path.isdir(full) and name in possible_formats:
                return name, full
    except Exception:
        pass

    return None, None

# ---------- Thread de transferência ----------
class TransferWorker(threading.Thread):
    def __init__(self, src_subfolder, dst_root, callback_progress, callback_finished):
        super().__init__()
        self.src_subfolder = src_subfolder
        self.dst_root = dst_root
        self.callback_progress = callback_progress
        self.callback_finished = callback_finished
        self._stop = False

    def run(self):
        try:
            files = []
            for root, dirs, filenames in os.walk(self.src_subfolder):
                for f in filenames:
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, self.src_subfolder)
                    files.append((full, rel))

            total = len(files)
            if total == 0:
                self.callback_finished(True, '🎅 Nenhum arquivo encontrado (pasta já está limpa!)')
                return

            dst_folder_name = os.path.basename(self.src_subfolder)
            dst_subfolder = os.path.join(self.dst_root, dst_folder_name)
            os.makedirs(dst_subfolder, exist_ok=True)

            moved = 0
            for full, rel in files:
                if self._stop:
                    break
                target_full = os.path.join(dst_subfolder, rel)
                os.makedirs(os.path.dirname(target_full), exist_ok=True)
                shutil.move(full, target_full)
                moved += 1
                pct = int(moved / total * 100)
                self.callback_progress(moved, total, pct)
                time.sleep(0.01)

            empty = not any(os.scandir(self.src_subfolder))
            if empty:
                msg = '🎄 Transferência concluída! Pasta de origem está limpa.'
            else:
                msg = '🎁 Transferência concluída, mas ainda restam arquivos na origem.'
            self.callback_finished(True, msg)
        except Exception as e:
            self.callback_finished(False, f'Erro: {e}')

    def stop(self):
        self._stop = True

# ---------- Interface Natalina ----------
WIDTH, HEIGHT = 640, 360
BG = (220, 0, 0)
TEXT_COLOR = (255, 255, 255)
BUTTON_COLOR = (0, 120, 0)
HOVER_COLOR = (0, 180, 0)
PROGRESS_COLOR = (255, 215, 0)


def draw_button(screen, rect, text, font, mouse_pos):
    x, y, w, h = rect
    r = pygame.Rect(rect)
    color = HOVER_COLOR if r.collidepoint(mouse_pos) else BUTTON_COLOR
    pygame.draw.rect(screen, color, r, border_radius=10)
    txt = font.render(text, True, TEXT_COLOR)
    screen.blit(txt, txt.get_rect(center=r.center))


def main():
    pygame.init()
    pygame.display.set_caption('🎅 Mover por Data - Edição Natalina 🎁')
    screen = pygame.display.set_mode((WIDTH, HEIGHT))
    clock = pygame.time.Clock()
    font = pygame.font.SysFont('arial', 22, bold=True)
    bigfont = pygame.font.SysFont('arial', 28, bold=True)

    config = load_config()
    src = config.get('src', '')
    dst = config.get('dst', '')

    # Se não há configuração salva, abre os diálogos de seleção
    if not src or not dst:
        src = choose_folder_dialog('🎄 Selecione a PASTA 1 (fonte)')
        if not src:
            messagebox.showinfo('Aviso', 'Nenhuma pasta selecionada. Encerrando.')
            return
        dst = choose_folder_dialog('🎁 Selecione a PASTA 2 (destino)')
        if not dst:
            messagebox.showinfo('Aviso', 'Nenhuma pasta selecionada. Encerrando.')
            return
        config['src'] = src
        config['dst'] = dst
        save_config(config)

    status = 'Pronto para transferir! 🎅'
    progress = 0
    moved = 0
    total = 0
    worker = None

    running = True
    while running:
        mouse_pos = pygame.mouse.get_pos()
        for event in pygame.event.get():
            if event.type == QUIT:
                running = False
            elif event.type == MOUSEBUTTONDOWN and event.button == 1:
                mx, my = event.pos
                # Iniciar transferência
                if 200 <= mx <= 440 and 200 <= my <= 260:
                    name, subpath = find_today_subfolder(src)
                    if not name:
                        status = f'🎁 Nenhuma subpasta de hoje encontrada em {src}'
                    else:
                        status = f'🎅 Transferindo arquivos da pasta {name}...'
                        progress = 0
                        moved = 0
                        total = 0

                        def on_progress(mv, tot, pct):
                            nonlocal moved, total, progress
                            moved = mv
                            total = tot
                            progress = pct

                        def on_finished(ok, message):
                            nonlocal status, worker
                            status = message
                            worker = None

                        worker = TransferWorker(subpath, dst, on_progress, on_finished)
                        worker.start()

        # Desenho da tela
        screen.fill(BG)

        title = bigfont.render('🎄 Mover Pastas - Especial de Natal 🎁', True, TEXT_COLOR)
        screen.blit(title, (WIDTH // 2 - title.get_width() // 2, 30))

        path_text1 = font.render(f'Origem: {src}', True, TEXT_COLOR)
        path_text2 = font.render(f'Destino: {dst}', True, TEXT_COLOR)
        screen.blit(path_text1, (40, 100))
        screen.blit(path_text2, (40, 130))

        draw_button(screen, (200, 200, 240, 60), '🎅 INICIAR TRANSFERÊNCIA 🎁', font, mouse_pos)

        # Barra de progresso
        pygame.draw.rect(screen, (120, 0, 0), (40, 280, WIDTH - 80, 30), border_radius=8)
        if total > 0:
            bar_w = int((WIDTH - 80) * (progress / 100))
            pygame.draw.rect(screen, PROGRESS_COLOR, (40, 280, bar_w, 30), border_radius=8)
            pct_txt = font.render(f'{progress}% ({moved}/{total})', True, (0, 0, 0))
            screen.blit(pct_txt, (WIDTH // 2 - pct_txt.get_width() // 2, 285))

        status_txt = font.render(status, True, TEXT_COLOR)
        screen.blit(status_txt, (40, 330))

        pygame.display.flip()
        clock.tick(30)

    pygame.quit()

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        tk.Tk().withdraw()
        messagebox.showerror('Erro', str(e))
        sys.exit(1)
