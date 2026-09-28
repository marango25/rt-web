# Lo que sirve del manual de fábrica para el Sonoma

Fuente: *1993 Light Duty Truck Fuel and Emissions Service Manual* **ST-336-93**
(`~/Downloads/1993_ST-336-93_..._FUEL_AND_EMISSIONS_MANUAL.pdf`, 872 págs.).
Para el **2.8L S con caja manual** aplican: **3B** (ECM "GMCM"), **4B** (TBI modelo 220),
**6** (encendido), **7** (sensor de detonación), **8** (AIR), **9B** (EGR de puerto),
**11** (PCV), **12** (Thermac) y **2** (síntomas). Las secciones 3A/4A son del 2.5L; no las uses.

Página del PDF = número impreso + desplazamiento: 3B-n → pág. 178+n; 4B-n → 659+n.

Este manual **no trae** bujías (tipo y separación), orden de encendido, torques del motor,
capacidades ni el diagrama eléctrico completo del S/T: todo eso está en el
**ST-369-93 Blazer and Pickup Service Manual (S/T)**.

---

## 1. Valores de fábrica

### Ralentí, tiempo y combustible

| Qué | Spec | El camión (2026-09-28) | Fuente |
|---|---|---|---|
| Ralentí controlado (neutral, caliente, sin A/C) | **800 RPM, IAC 5–20**, lazo **abierto** | ~800, IAC 9–13 → OK | pág. 4-4 (PDF 635) |
| IAC por altitud | +1 count cada 1000 ft | — | pág. 4-4 |
| Tornillo de mínimo | "no se debe ajustar" (solo hay procedimiento para el 7.4L) | ya se movió el 09-22/09-24 | 4B-6, 4B-14 |
| Tiempo base | **10° BTDC a ≤600 RPM**, conector SET TIMING abierto | 10° | 6-9 |
| Presión en el TBI | **9–13 psi** (62–90 kPa); la bomba da ~18 psi | 12–14 psi | 4B-2, 4B-12 |
| Presión baja / alta | baja → mal rendimiento; alta → emisiones y olor en el escape | — | 4B-2 |
| Inyectores | el TBI 220 acepta inyectores de otros motores, pero con otro caudal | 203 (del 4.3) | 4B-15 |

### Datos del escáner (ralentí caliente, lazo cerrado, acelerador cerrado, neutral, sin accesorios)

Tabla "Typical Scan Data Values", 3B-8 (PDF 186). Es lo más parecido a un "así se ve
un motor sano" que hay para este ECM.

| Parámetro | Típico de fábrica | Notas |
|---|---|---|
| RPM | ±100 del objetivo | |
| Refrigerante | 85–105 °C | el termostato abre ~90 °C (3B-11) |
| TPS | 0.45–1.25 V (texto: "cerca de 0.60" cerrado) | en llave ON debe pasar de <1.25 V a >4.5 V en WOT |
| O2 | 100–999 mV, cambiando siempre | solo en lazo cerrado |
| **INT (short term)** | **110–145** | ya en el `.adx` como rango de alerta |
| **BLM (long term)** | **118–138** | ya en el `.adx`; con carga baja a 112–115 y se marca, es normal |
| IAC | 1–50 | con A/C pedido la ECM fija ~74–76, también normal |
| Batería | 13.5–14.5 V | código 53 si pasa de 17.1 V por 2 s |
| Knock signal | "No" | a ralentí nunca debe haber |
| MAP en ralentí | **1.0 V** (llave ON motor apagado: 4.8 V) | tabla de voltajes 3B-87 |

- **BLM ≈ 150 = la condición del código 44** (pobre); **≈ 115 = la del código 45** (rico)
  (3B-11). Con los GP estaba en 152–158: rozando el 44. Con los 203, 119–123.
- El MAP de ralentí del camión (1.16–1.31 V) está algo arriba del 1.0 V del auto de
  referencia, o sea un poco menos de vacío. La altitud lo mueve y el vacuómetro dio
  17–17.8 inHg estables: **no es un hallazgo**, es un dato para tener a mano.

---

## 2. Detonación: lo que dice el manual y en qué va cada punto

Lista de "Detonation/Spark Knock" (2-10, 2-11), con lo ya hecho marcado:

| Revisión del manual | Estado |
|---|---|
| BLM > 150 = mezcla pobre | ✅ resuelto con los 203 (BLM ~120) |
| Presión de combustible | ✅ 12–14 psi |
| Octanaje: "premium de al menos 92 octanos" | ✅ premium con aditivo desde el 2026-09-27 |
| Tiempo base | ✅ 10° |
| Sensor de temperatura corrido | ✅ lectura sana en todos los logs |
| Enfriamiento | ✅ se topa en 94–96 °C, dentro de 85–105 |
| **Válvula EGR y pasajes** | ⬜ **sin revisar** — ver 3.1 |
| **Thermac (aire caliente)** | ⬜ **sin revisar** — ver 3.2 |
| **Sistema del sensor de detonación** | ⬜ sin revisar — ver 3.3 |
| Bujías (rango térmico y separación) | ⬜ datos en el ST-369, no aquí |
| Carbón en cámaras (limpiador de motor por admisión) | ⬜ |
| Boletines de PROM actualizada | ⬜ (va con el proyecto de la PROM) |

### Cómo funciona el sensor de detonación en este ECM (7-2 a 7-5)

- Es de **módulo externo**: el módulo le manda a la ECM **8–10 V** (pin B7, ~9 V) cuando
  no hay detonación y **corta** esa señal cuando la hay.
- La ECM **solo retarda por arriba de 900 RPM**, y como máximo **20°**.
- **Auto-prueba:** con refrigerante **>95 °C y carga cerca de WOT**, la ECM **adelanta la
  chispa a propósito** para comprobar que el sensor responde, una vez por encendido. Si no
  detecta nada, prende el Check Engine hasta el siguiente encendido (código 43).
  **Consecuencia para leer logs:** parte de los eventos a ≥95 °C con MAP alto pueden ser
  la ECM provocándolos. Al contar detonación, separa los frames de ≥95 °C.
- Sin señal del sensor (cable suelto, módulo sin tierra) la ECM cree que **nunca** hay
  detonación y no retarda: "la detonación puede volverse severa con carga".

---

## 3. Pruebas gratis pendientes, paso a paso

### 3.1 EGR (9B-4/9B-5, PDF 811–812)

El 2.8L S lleva **EGR de puerto** con solenoide **EVRV** (pin A4, cable gris). El manual:
*"si los pasajes están tapados, el motor puede tener detonación severa al acelerar"*, y
poco EGR causa detonación y calentamiento con carga.

1. **Motor caliente en ralentí: levanta el diafragma de la válvula EGR con la mano.**
   - El ralentí **empeora** (casi se apaga) → pasa gas, bien.
   - **No cambia** → pasajes tapados: quitar la válvula y limpiar los pasajes.
2. Si quieres la prueba completa: vacuómetro en la manguera de la válvula, en primera,
   acelerar suave desde parado → debe haber vacío, pero **menos de 10 inHg**; si hay más,
   limpiar o cambiar el filtro del EVRV.

Matiz: la ECM se vigila el EGR sola (código 32) por arriba de **45 MPH**, acelerador
**6–30 %**, vacío 12.5–60 kPa, sin mover el pedal (3B-58). Nunca ha salido el 32 y sí
se ha manejado a 50–56 MPH, así que **un tapón total es poco probable; uno parcial puede
pasar la prueba**. El flujo ALDL de este ECM no manda nada del EGR: solo se revisa a mano.

Ojo: con el puente A-B a tierra la ECM **energiza el solenoide del EGR** (3B-58).

### 3.2 Thermac — compuerta de aire caliente (12-1 a 12-3)

En el 2.8L el filtro tiene una compuerta de vacío con sensor de temperatura. Si se queda
cerrada, el motor respira aire calentado por el múltiple de escape → falta de potencia
(y más propensión a detonar) en caliente.

1. Con el filtro montado y el motor apagado, la compuerta debe estar **abierta al aire
   exterior**.
2. En frío (filtro < 30 °C) al arrancar debe **cerrarse**, y abrirse poco a poco al
   calentarse; el sensor debe empezar a abrirla a **~55 °C** dentro del filtro.
3. Motor de vacío: con 7 inHg debe cerrar la compuerta del todo y quedarse cerrada si
   atrapas el vacío doblando la manguera.
4. Revisar también el tubo de la "estufa" (del múltiple al snorkel) y el sello del filtro
   al TBI.

Buen momento para hacerlo: cuando cambie el filtro de aire.

### 3.3 Prueba de golpes al sensor de detonación (7-5, PDF 774)

Valida que el "Contador de detonación" del ALDL de verdad sigue al sensor (nunca lo
hemos comprobado):

1. Web app en vivo, motor a **~1500 RPM** en neutral.
2. **Golpear el bloque cerca del sensor** (o el múltiple de escape derecho) con algo
   metálico.
3. El contador debe subir. Si no sube: cable, conexión o módulo.
4. Si ya sube **sin golpear** a 1500 RPM sin carga: desconectar el sensor; si sigue
   subiendo, el cable toma ruido de otro cable (rerutear) o el módulo está mal; si deja de
   subir, hay ruido interno del motor o el sensor está mal.

### 3.4 PCV (11-2)

Ralentí áspero o inestable → revisar la válvula PCV:
1. Motor en ralentí, sacar la válvula de la tapa de punterías y tapar con el dedo: debe
   haber vacío.
2. Motor apagado, agitar la válvula: debe **sonar**. Si no suena, cambiarla (es barata).

### 3.5 Pop en ralentí — lo que el manual manda revisar (2-19, "Backfire")

No es un diagnóstico, es la lista del manual para estallidos en admisión o escape:
- **Válvula check del AIR** con falla (sección 8).
- Cables de bujía cruzados o con fuga de chispa (tapa, cables, ruteo), bujías.
- Tiempo de encendido.
- Válvulas que no sellan, empaques de múltiple (ya descartado en parte: el pop depende
  del avance).

Dato relacionado: en el S el sistema **AIR manda aire a los puertos de escape en
ralentí** (sección 8-2) y la ECM lo desvía al filtro en lazo cerrado, con motor frío o
en enriquecimiento. Los dos bits del AIR ya están en el `.adx` (byte 16 bits 0 y 1);
**en el próximo log vale la pena ver qué hacen justo cuando se oye el pop.** Aire en el
escape en el momento equivocado también da una **lectura falsa de pobre** en el O2 y la
ECM mete combustible de más.

---

## 4. A/C: cómo lo maneja la ECM (3B-34 a 3B-38)

- Al pedir A/C, la ECM espera **~½ s** antes de enganchar el compresor (pin A2 → relé).
- **Suelta el embrague si el ralentí cae demasiado.**
- Mete **combustible extra en el instante** en que engancha.
- Si el ralentí se hunde al enganchar o se dispara al soltar, revisar el circuito 59 al
  pin B8 (petición de A/C). Ya pasó: el falso contacto del 2026-09-24.
- Relés y solenoides que maneja la ECM deben medir **más de 20 Ω**; menos daña el
  "quad-driver" de la ECM. Mídelo antes de culpar a la ECM.

Para el próximo log con A/C: mirar si el bit del embrague se cae cuando el RPM baja a
550–700 en los altos. Si no se cae nunca, ese umbral de la PROM está bajo.

---

## 5. Mantenimiento y reseteos

- **Reset de la IAC** (4B-8): batería desconectada 10 s → reconectar → arrancar y dejar
  5 s → llave en OFF 10 s. Hazlo cuando borres el código 42 desconectando la batería.
- **Reaprendizaje de la ECM** (3B-3): tras desconectar la batería, motor caliente,
  manejar a medio acelerador con aceleraciones moderadas y ralentís "hasta que vuelva el
  rendimiento normal".
- **Canister (EVAP), solo 2.8L** (sección 5): un interruptor térmico de vacío en el múltiple
  bloquea la purga por debajo de 46 °C y la deja pasar arriba de eso.
- **Bomba de gasolina** (3B-10): el relé la prende 2 s con la llave; si el relé falla, el
  interruptor de presión de aceite la prende a ~4 psi de aceite (arranque largo, sobre
  todo en frío).
- **Bomba AIR**: sin mantenimiento; a 1500 RPM el flujo de la manguera debe aumentar al
  acelerar.

---

## 6. Pines del ECM 2.8L (3B-85 a 3B-88), los que importan

Voltajes con motor caliente, lazo cerrado, en ralentí, **sin** puente A-B y **sin**
escáner (nuestro puente ALDL es solo de lectura, pero tenlo en cuenta al medir).

| Pin | Función | Cable | Llave ON | Motor andando |
|---|---|---|---|---|
| A2 | Control del relé del A/C | DK GRN/WHT | — | — |
| A4 | Control EGR (EVRV) | GRY | B+ | B+ |
| A8 | **Datos serie (ALDL)** | ORN | 2–5 V (promedio en voltímetro) | 2–5 V |
| A9 | Terminal de diagnóstico (pin B del ALDL) | WHT/BLK | 5 V | 5 V |
| A10 | Señal VSS (del buffer/DRAC) | BRN | 0–B+ según rueda | 0–B+ |
| B5 | Referencia IC "alta" | PPL/WHT | 0 | 1.6 V |
| B7 | Señal de detonación | BLK | 9 V | 9 V |
| B8 | Petición de A/C | DK GRN | 0 V A/C off / B+ A/C on | igual |
| C2 | Señal AIR bypass | BRN | B+ | B+ |
| C10 | Sensor de temperatura | YEL | varía | varía |
| C11 | MAP | LT GRN | 4.8 V | **1.0 V** |
| C13 | TPS | DK BLU | — | 0.6 V |

---

## 7. Otros documentos (revisado el 2026-09-28)

El hilo de gmt400.com "88-98 service manuals" es casi todo de la C/K (GMT400, la de
tamaño completo) y **no trae nada específico del S/T 1993**. De ahí y de fuentes
relacionadas, lo que sirve:

| Qué | Para qué | Enlace |
|---|---|---|
| Catálogo de partes S10/Sonoma 2WD 1991–1993 (nemigaparts) | números de parte y despieces: EGR, PCV, AIR, Thermac, caja | https://nemigaparts.com/cat_spares/epc/chevrolet/53s-s/ |
| charm.li (manuales de fábrica 1982–2013) | probablemente la mejor fuente gratis del Sonoma 1993; **estaba caído**, reintentar | https://charm.li/Chevrolet/ |
| Reparación de arneses GM (STG 18001.02) | empalmes de la resistencia del VSS y del diodo del compresor | https://www.mediafire.com/file/g4qu12dahudvrya/GM_STG_18001_02_VA_Wiring_Assembly_Repairs.pdf/file |
| Reparación de arneses Packard | lo mismo, conectores Packard | https://www.mediafire.com/file/uhjb9syvn2ydvrw/Packard_Electric_Repairing_Wiring_Harnesses.pdf/file |
| Hoja de cálculo RPM/engranes/eje | contrastar el velocímetro contra GPS; hay que meterle las relaciones del S/T | http://www.mediafire.com/download/zk4j8ymtctekx5r/RPM_Gear_Axle_Transmission_TransferCase.zip |
| Unit Repair 1995 (NV3500) | overhaul de la caja de 5 vel. **si** es NV3500 (confirmar RPO en la guantera) | http://www.mediafire.com/file/5hd9d64c95g3i9g/GMT_95_LUR_1995_GM_Light_Duty_Truck_Unit_Repair_Manual.pdf/file |
| Unit Repair 1999 vol. 2 (NV3500, índice verificado) | lo mismo, más nuevo | https://www.mediafire.com/file/xlasxcs5yrqsvmp/1999_Unit_Repair_Volume_2.pdf/file |

**El que falta de verdad es el ST-369-93** (Blazer and Pickup Service Manual S/T): bujías,
orden de encendido, torques, capacidades y diagramas eléctricos del S/T. No está gratis en
ningún lado encontrado. Impreso: Amazon
(https://www.amazon.com/Trucks-Service-Manual-Models-369-93/dp/B003QCV224) o Helm Inc
(https://www.helminc.com). Alternativa: Chilton S10/S15 1982–94 en préstamo en archive.org
(https://archive.org/details/chiltonsgeneralm0000unse_w7n3).

No sirven: la lista "GM OBD1 Codes.pdf" del hilo (mezcla códigos de varios ECM) y los
pinouts citados ahí (son de otros ECM, no del 1228062).
