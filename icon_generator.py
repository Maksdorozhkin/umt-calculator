import os
from PIL import Image, ImageDraw, ImageFont

def generate_pwa_icons(output_dir="static"):
    os.makedirs(output_dir, exist_ok=True)
    sizes = [192, 512]
    
    # Настройки стиля
    bg_color = "#1E252B"      # Строгий темно-серый индустриальный фон
    text_color = "#FF9F43"    # Яркий оранжевый/amber цвет для текста
    line_color = "#FF9F43"    # Цвет подчеркивания
    
    for size in sizes:
        # Создаем квадратное изображение
        img = Image.new("RGBA", (size, size), bg_color)
        draw = ImageDraw.Draw(img)
        
        # Подбираем шрифт (используем стандартный системный, чтобы скрипт работал везде)
        try:
            # Для Windows/Linux/Mac пытаемся загрузить четкий шрифт без засечек
            font_size = int(size * 0.3)
            font = ImageFont.truetype("arial.ttf", font_size)
        except IOError:
            font = ImageFont.load_default()
            
        # Текст для иконки
        text = "ЮМТ"
        
        # Вычисляем координаты центра для текста
        # В старых версиях Pillow используется textsize, в новых textlength/textbbox
        try:
            bbox = draw.textbbox((0, 0), text, font=font)
            text_w = bbox[2] - bbox[0]
            text_h = bbox[3] - bbox[1]
        except AttributeError:
            text_w, text_h = draw.textsize(text, font=font)
            
        text_x = (size - text_w) // 2
        text_y = (size - text_h) // 2 - int(size * 0.05)
        
        # Рисуем текст
        draw.text((text_x, text_y), text, fill=text_color, font=font)
        
        # Добавляем стильное технологичное подчеркивание под текстом
        line_y = text_y + text_h + int(size * 0.08)
        draw.line(
            [(size * 0.25, line_y), (size * 0.75, line_y)], 
            fill=line_color, 
            width=max(2, int(size * 0.02))
        )
        
        # Сохраняем файлы напрямую в директорию статики Flask
        filename = f"icon-{size}.png"
        img.save(os.path.join(output_dir, filename))
        print(f"Создана иконка: {output_dir}/{filename}")

if __name__ == "__main__":
    # Запустите в корне вашего проекта Flask
    generate_pwa_icons()

