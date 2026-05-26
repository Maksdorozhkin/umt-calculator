import math
import os
import sqlite3
from datetime import datetime, timedelta

from flask import Flask, jsonify, render_template, request
from flask_sqlalchemy import SQLAlchemy

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///production.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = "production-calculator-2024"

db = SQLAlchemy(app)


# Модели базы данных
class Product(db.Model):
    """Общий справочник продукции"""

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False, unique=True)
    cavitations = db.Column(db.Integer, nullable=False)
    cycles_per_minute = db.Column(db.Float, nullable=False)
    pieces_per_box = db.Column(db.Integer, nullable=False)
    boxes_per_pallet = db.Column(db.Integer, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.now)


class MachineProduct(db.Model):
    """Связь машины с текущим продуктом"""

    id = db.Column(db.Integer, primary_key=True)
    machine_id = db.Column(db.Integer, nullable=False, unique=True)
    product_id = db.Column(db.Integer, db.ForeignKey("product.id"), nullable=True)


class DowntimeLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    machine_id = db.Column(db.Integer, nullable=False)
    downtime_type = db.Column(db.String(50), nullable=False)
    duration_minutes = db.Column(db.Integer, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.now)
    note = db.Column(db.String(200), default="")


class TapeCalculation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    avg_weight = db.Column(db.Float, nullable=False)
    waste_percent = db.Column(db.Float, nullable=False)
    required_pieces = db.Column(db.Integer, nullable=False)
    result_tape = db.Column(db.Float, nullable=False)
    result_tape_plus_10 = db.Column(db.Float, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.now)


MACHINES = [1, 2, 3, 4, 5, 6, 7]
# старая функция с ощибкой
# def get_current_shift():
# """Определяет текущую смену"""
# now = datetime.now()
# hour = now.hour
# minute = now.minute


# if 8 <= hour < 19 or (hour == 19 and minute <= 50):
# return 'day', datetime(now.year, now.month, now.day, 19, 50)
# else:
#        return 'night', datetime(now.year, now.month, now.day, 7, 50) + timedelta(days=1)


# def get_current_shift():
#     """Определяет текущую смену (День/Ночь) и рассчитывает время окончания с учетом смещения в -10 минут."""
#     now = datetime.now()
#     BOUNDARY_HOUR = 20  # Конечная граница дня / начало ночи (20:00)
#     SHIFT_END_ADJUSTMENT = timedelta(minutes=10)

#     hour = now.hour
#     minute = now.minute

#     if (8 <= hour < BOUNDARY_HOUR) or (hour == 8 and minute < 60):  # Добавляем проверку
#         shift_type = "day"
#         target_end = datetime(now.year, now.month, now.day, BOUNDARY_HOUR, 0)
#     else:
#         shift_type = "night"
#         target_end = datetime(now.year, now.month, now.day + 1, 8, 0)

#     shift_end = target_end - SHIFT_END_ADJUSTMENT
#     return shift_type, shift_end


def get_current_shift():
    """Определяет текущую смену (День/Ночь) и рассчитывает время окончания с учетом смещения в -10 минут."""
    now = datetime.now()
    BOUNDARY_HOUR = 20  # Конечная граница дня / начало ночи (20:00)
    SHIFT_END_ADJUSTMENT = timedelta(minutes=10)

    hour = now.hour

    if 8 <= hour < BOUNDARY_HOUR:
        # Дневная смена: началась сегодня в 08:00, закончится сегодня в 20:00
        shift_type = "day"
        target_end = now.replace(hour=BOUNDARY_HOUR, minute=0, second=0, microsecond=0)
    else:
        # Ночная смена
        shift_type = "night"
        if hour >= BOUNDARY_HOUR:
            # Время от 20:00 до 23:59. Смена закончится ЗАВТРА в 08:00.
            # Используем timedelta(days=1) вместо now.day + 1, чтобы не сломать конец месяца
            tomorrow = now + timedelta(days=1)
            target_end = tomorrow.replace(hour=8, minute=0, second=0, microsecond=0)
        else:
            # Время от 00:00 до 07:59 (ваше "под утро"). Смена закончится СЕГОДНЯ в 08:00.
            target_end = now.replace(hour=8, minute=0, second=0, microsecond=0)

    shift_end = target_end - SHIFT_END_ADJUSTMENT
    return shift_type, shift_end


def calculate_production(product, machine_id):
    """Рассчитывает выпуск до конца смены. Возвращает: (паллеты, коробки_остаток, штуки)"""
    shift_type, shift_end = get_current_shift()
    now = datetime.now()

    time_remaining = (shift_end - now).total_seconds() / 60
    if time_remaining <= 0:
        return 0, 0, 0

    shift_start = shift_end - timedelta(hours=11, minutes=50)
    downtimes = DowntimeLog.query.filter(
        DowntimeLog.machine_id == machine_id,
        DowntimeLog.timestamp >= shift_start,
        DowntimeLog.timestamp <= shift_end,
    ).all()

    total_downtime = sum(d.duration_minutes for d in downtimes)
    effective_time = max(0, time_remaining - total_downtime)

    total_pieces = effective_time * product.cycles_per_minute * product.cavitations
    total_boxes = total_pieces / product.pieces_per_box
    total_pallets = total_boxes / product.boxes_per_pallet

    full_pallets = math.floor(total_pallets)
    remaining_boxes = math.floor(total_boxes) - (
        full_pallets * product.boxes_per_pallet
    )

    return full_pallets, remaining_boxes, math.floor(total_pieces)


# ====== Маршруты ======


@app.route("/")
def index():
    shift_type, _ = get_current_shift()
    machines = []
    for machine_id in MACHINES:
        machine_product = MachineProduct.query.filter_by(machine_id=machine_id).first()
        current_product = None
        if machine_product and machine_product.product_id:
            current_product = db.session.get(Product, machine_product.product_id)
        machines.append({"id": machine_id, "current_product": current_product})

    all_products = Product.query.order_by(Product.name).all()
    return render_template(
        "index.html",
        machines=machines,
        shift_type=shift_type,
        all_products=all_products,
    )


@app.route("/api/products", methods=["GET"])
def get_all_products():
    products = Product.query.order_by(Product.name).all()
    return jsonify(
        [
            {
                "id": p.id,
                "name": p.name,
                "cavitations": p.cavitations,
                "cycles_per_minute": p.cycles_per_minute,
                "pieces_per_box": p.pieces_per_box,
                "boxes_per_pallet": p.boxes_per_pallet,
            }
            for p in products
        ]
    )


@app.route("/api/products", methods=["POST"])
def save_product():
    try:
        data = request.json
        name = data["name"].strip()
        if not name:
            return jsonify({"success": False, "error": "Введите наименование"}), 400

        product = Product.query.filter_by(name=name).first()
        if product:
            product.cavitations = data["cavitations"]
            product.cycles_per_minute = data["cycles_per_minute"]
            product.pieces_per_box = data["pieces_per_box"]
            product.boxes_per_pallet = data["boxes_per_pallet"]
            db.session.commit()
            return jsonify({"success": True, "id": product.id, "updated": True})
        else:
            product = Product(
                name=name,
                cavitations=data["cavitations"],
                cycles_per_minute=data["cycles_per_minute"],
                pieces_per_box=data["pieces_per_box"],
                boxes_per_pallet=data["boxes_per_pallet"],
            )
            db.session.add(product)
            db.session.commit()
            return jsonify({"success": True, "id": product.id, "updated": False})
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/products/<int:id>")
def get_product(id):
    product = db.session.get(Product, id)
    if not product:
        return jsonify({"error": "Продукт не найден"}), 404
    return jsonify(
        {
            "id": product.id,
            "name": product.name,
            "cavitations": product.cavitations,
            "cycles_per_minute": product.cycles_per_minute,
            "pieces_per_box": product.pieces_per_box,
            "boxes_per_pallet": product.boxes_per_pallet,
        }
    )


@app.route("/api/products/<int:id>", methods=["DELETE"])
def delete_product(id):
    try:
        product = db.session.get(Product, id)
        if not product:
            return jsonify({"success": False, "error": "Продукт не найден"}), 404
        MachineProduct.query.filter_by(product_id=id).delete()
        db.session.delete(product)
        db.session.commit()
        return jsonify({"success": True})
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/machine/<int:machine_id>/product", methods=["POST"])
def assign_product_to_machine(machine_id):
    try:
        data = request.json
        product_id = data.get("product_id")
        machine_product = MachineProduct.query.filter_by(machine_id=machine_id).first()
        if machine_product:
            machine_product.product_id = product_id
        else:
            machine_product = MachineProduct(
                machine_id=machine_id, product_id=product_id
            )
            db.session.add(machine_product)
        db.session.commit()
        return jsonify({"success": True})
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/machine/<int:machine_id>/product")
def get_machine_product(machine_id):
    machine_product = MachineProduct.query.filter_by(machine_id=machine_id).first()
    if machine_product and machine_product.product_id:
        product = db.session.get(Product, machine_product.product_id)
        if product:
            return jsonify(
                {
                    "id": product.id,
                    "name": product.name,
                    "cavitations": product.cavitations,
                    "cycles_per_minute": product.cycles_per_minute,
                    "pieces_per_box": product.pieces_per_box,
                    "boxes_per_pallet": product.boxes_per_pallet,
                }
            )
    return jsonify({"error": "Нет назначенного продукта"})


@app.route("/api/downtime", methods=["POST"])
def log_downtime():
    try:
        data = request.json
        downtime = DowntimeLog(
            machine_id=data["machine_id"],
            downtime_type=data["downtime_type"],
            duration_minutes=data["duration_minutes"],
            note=data.get("note", ""),
        )
        db.session.add(downtime)
        db.session.commit()
        return jsonify({"success": True, "id": downtime.id})
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/downtime/machine/<int:machine_id>")
def get_machine_downtime(machine_id):
    try:
        shift_type, shift_end = get_current_shift()
        shift_start = shift_end - timedelta(hours=11, minutes=50)

        downtimes = (
            DowntimeLog.query.filter(
                DowntimeLog.machine_id == machine_id,
                DowntimeLog.timestamp >= shift_start,
                DowntimeLog.timestamp <= shift_end,
            )
            .order_by(DowntimeLog.timestamp.desc())
            .all()
        )

        return jsonify(
            [
                {
                    "id": d.id,
                    "downtime_type": d.downtime_type,
                    "duration_minutes": d.duration_minutes,
                    "timestamp": d.timestamp.isoformat(),
                    "note": d.note,
                }
                for d in downtimes
            ]
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/downtime/<int:id>", methods=["DELETE"])
def delete_downtime(id):
    try:
        downtime = db.session.get(DowntimeLog, id)
        if not downtime:
            return jsonify({"success": False, "error": "Запись не найдена"}), 404
        db.session.delete(downtime)
        db.session.commit()
        return jsonify({"success": True})
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/calculate/<int:machine_id>")
def calculate_machine_production(machine_id):
    try:
        machine_product = MachineProduct.query.filter_by(machine_id=machine_id).first()
        if not machine_product or not machine_product.product_id:
            return jsonify({"error": "Нет назначенного продукта"})

        product = db.session.get(Product, machine_product.product_id)
        if not product:
            return jsonify({"error": "Продукт не найден"})

        pallets, boxes, pieces = calculate_production(product, machine_id)
        return jsonify(
            {
                "pallets": pallets,
                "boxes": boxes,
                "pieces": pieces,
                "product_name": product.name,
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/tape-calculation", methods=["POST"])
# def calculate_tape(): # считала без учета дробленки
#    try:
#        data = request.json
#        avg_weight = float(data['avg_weight'])
#        waste_percent = float(data['waste_percent'])
#        required_pieces = int(data['required_pieces'])

#        total_weight = avg_weight * required_pieces
#        tape_needed = total_weight / (1 - waste_percent / 100)
#        tape_plus_10 = tape_needed * 1.1

#        calc = TapeCalculation(
#            avg_weight=avg_weight, waste_percent=waste_percent,
#            required_pieces=required_pieces,
#            result_tape=tape_needed, result_tape_plus_10=tape_plus_10
#        )
#        db.session.add(calc)
#        db.session.commit()

#        return jsonify({
#            'tape_needed': round(tape_needed, 2),
#            'tape_plus_10': round(tape_plus_10, 2)
#        })
#    except Exception as e:
#        db.session.rollback()
#        return jsonify({'success': False, 'error': str(e)}), 500
#
##############################
# def calculate_tape():
#     try:
#         data = request.json
#         avg_weight = float(data["avg_weight"])  # Вес 1 шт. в граммах (например: 70.04)
#         waste_percent = float(data["waste_percent"])  # Отходность в % (например: 27)
#         required_pieces = int(data["required_pieces"])  # Тираж в шт. (например: 20000)

#         pure_total_weight_kg = (avg_weight * required_pieces) / 1000

#         base_tape_needed = pure_total_weight_kg / (1 - (waste_percent / 100))

#         tape_needed = base_tape_needed * 1.05
#         droblenka_output = tape_needed - pure_total_weight_kg
#         tape_plus_10 = tape_needed * 1.1
#         calc = TapeCalculation(
#             avg_weight=avg_weight,
#             waste_percent=waste_percent,
#             required_pieces=required_pieces,
#             result_tape=tape_needed,
#             result_tape_plus_10=tape_plus_10,
#         )
#         db.session.add(calc)
#         db.session.commit()
#         return jsonify(
#             {
#                 "tape_needed": round(tape_needed, 2),
#                 "droblenka_output": round(droblenka_output, 2),
#                 "tape_plus_10": round(tape_plus_10, 2),
#             }
#         )

#     except Exception as e:
#         db.session.rollback()
#         return jsonify({"success": False, "error": str(e)}), 500

def calculate_tape():
    try:
        data = request.json
        avg_weight = float(data["avg_weight"])
        waste_percent = float(data["waste_percent"])
        required_pieces = int(data["required_pieces"])

        # 1. Вычисляем чистый вес всей готовой партии в кг
        pure_total_weight_kg = (avg_weight * required_pieces) / 1000

        # 2. Рассчитываем базовую потребность по формуле баланса массы
        base_tape_needed = pure_total_weight_kg / (1 - (waste_percent / 100))

        # 3. Применяем скрытый технологический коэффициент 1.05 (зашитый в таблицу запас 5%)
        # Для теста (10г, 10%, 100к шт) это даст ровно 1166.67 кг (в Excel округлено до 1167)
        tape_needed = base_tape_needed * 1.05

        # 4. Считаем выход дробленки (Разница между зашедшей лентой и чистым весом)
        # Для теста: 1166.67 - 1000 = 166.67 кг
        droblenka_output = tape_needed - pure_total_weight_kg

        # 5. надбавка +10% поверх заводского норматива Excel
        tape_plus_10 = tape_needed * 1.1

        # Сохраняем расчет в базу данных
        calc = TapeCalculation(
            avg_weight=avg_weight,
            waste_percent=waste_percent,
            required_pieces=required_pieces,
            result_tape=round(tape_needed, 2),
            result_tape_plus_10=round(tape_plus_10, 2),
        )
        db.session.add(calc)
        db.session.commit()

        # Возвращаем результат, округленный до 2 знаков
        return jsonify(
            {
                "tape_needed": round(tape_needed, 2),
                "droblenka_output": round(droblenka_output, 2),
                "tape_plus_10": round(tape_plus_10, 2),
            }
        )

    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/reset-database", methods=["POST"])
def reset_database():
    """Очистить все данные в базе"""
    try:
        DowntimeLog.query.delete()
        MachineProduct.query.delete()
        Product.query.delete()
        TapeCalculation.query.delete()
        db.session.commit()
        return jsonify({"success": True, "message": "База данных очищена"})
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(host="0.0.0.0", port=5000, debug=False)
