#!/usr/bin/env node
/**
 * DIAGNÓSTICO VISTAX — 3 BUGS CRÍTICOS
 * 
 * Ejecutar desde vistax-server/:
 *   node DIAGNOSTICO_3_BUGS.js
 * 
 * Genera un reporte de:
 *   1. ¿Existe nodos_inventory.json y tiene nodos?
 *   2. ¿Se cargan los perfiles con estructura de trenes?
 *   3. ¿Guarda correctamente config y republicar?
 */

const fs   = require("fs");
const path = require("path");

const PROFILES_DIR = path.join(__dirname, "data/implementos");
const INVENTORY_FILE = path.join(__dirname, "data/nodos_inventario.json");
const SETTINGS_FILE = path.join(__dirname, "data/settings.json");

console.log("\n╔════════════════════════════════════════════╗");
console.log("║  DIAGNÓSTICO VISTAX — 3 BUGS CRÍTICOS     ║");
console.log("╚════════════════════════════════════════════╝\n");

// ─────────────────────────────────────────────────────────────
// BUG 1: NO se ven los nodos
// ─────────────────────────────────────────────────────────────
console.log("🔍 BUG 1: NO se ven los nodos");
console.log("─" + "─".repeat(40));

if (!fs.existsSync(INVENTORY_FILE)) {
  console.log("❌ INVENTARIO NO EXISTE: " + INVENTORY_FILE);
  console.log("   → Los nodos no se están guardando\n");
} else {
  try {
    const inv = JSON.parse(fs.readFileSync(INVENTORY_FILE, "utf-8"));
    const nodos = inv.nodos || {};
    const count = Object.keys(nodos).length;
    
    if (count === 0) {
      console.log("⚠️  INVENTARIO VACÍO");
      console.log("   → Se debe ejecutar: G:\\...\\vistax-server\\");
      console.log("   → Luego conectar ESP32 nodos");
      console.log("   → Deberían aparecer al registrarse\n");
    } else {
      console.log(`✅ INVENTARIO TIENE ${count} NODO/S:`);
      Object.values(nodos).forEach(n => {
        console.log(`   • ${n.uid} | IP: ${n.ip} | FW: ${n.firmware}`);
      });
      console.log();
    }
  } catch (e) {
    console.log(`❌ INVENTARIO CORRUPTO: ${e.message}`);
    console.log(`   → Borrar: ${INVENTORY_FILE}`);
    console.log("   → Reiniciar servidor\n");
  }
}

// ─────────────────────────────────────────────────────────────
// BUG 2: No veo los trenes
// ─────────────────────────────────────────────────────────────
console.log("🔍 BUG 2: No veo los trenes");
console.log("─" + "─".repeat(40));

if (!fs.existsSync(PROFILES_DIR)) {
  console.log("❌ DIRECTORIO DE PERFILES NO EXISTE: " + PROFILES_DIR);
  console.log("   → Crear: " + PROFILES_DIR + "\n");
} else {
  const archivos = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith(".json"));
  
  if (archivos.length === 0) {
    console.log("⚠️  SIN PERFILES CREADOS");
    console.log("   → Crear uno desde la UI: /config\n");
  } else {
    console.log(`✅ PERFILES ENCONTRADOS: ${archivos.length}`);
    archivos.forEach(archivo => {
      try {
        const perfil = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, archivo), "utf-8"));
        const tieneTreenes = perfil.trenes && Object.keys(perfil.trenes).length > 0;
        const tendraSensores = perfil.mapeo_sensores && perfil.mapeo_sensores.length > 0;
        
        const status = tieneTreenes ? "✅" : "⚠️ ";
        console.log(`\n   ${status} ${perfil.nombre || archivo}`);
        console.log(`      • Trenes definidos: ${tieneTreenes ? "SÍ" : "NO"}`);
        if (tieneTreenes) {
          const treneIds = Object.keys(perfil.trenes);
          console.log(`        → ${treneIds.join(", ")}`);
        }
        console.log(`      • Sensores: ${tendraSensores ? perfil.mapeo_sensores.length : 0}`);
      } catch (e) {
        console.log(`   ❌ ${archivo}: JSON inválido`);
      }
    });
    console.log();
  }
}

// ─────────────────────────────────────────────────────────────
// BUG 3: Directamente no guarda nada
// ─────────────────────────────────────────────────────────────
console.log("🔍 BUG 3: Directamente no guarda nada");
console.log("─" + "─".repeat(40));

if (!fs.existsSync(SETTINGS_FILE)) {
  console.log("⚠️  SETTINGS NO PERSISTIDO");
  console.log("   → El último perfil usado no se guarda\n");
} else {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    console.log(`✅ ÚLTIMO PERFIL: ${settings.last_profile || "tanzi_default"}\n`);
  } catch (e) {
    console.log(`❌ SETTINGS CORRUPTO: ${e.message}\n`);
  }
}

// ─────────────────────────────────────────────────────────────
// RESUMEN Y ACCIONES
// ─────────────────────────────────────────────────────────────
console.log("═" + "═".repeat(40));
console.log("📋 ACCIONES RECOMENDADAS:");
console.log("═" + "═".repeat(40));

console.log(`
1️⃣  NODOS NO APARECEN:
   □ Verificar que mqtt_handler.js tenga:
     - Línea 16: const nodosInventory = require("../database/nodos_inventory");
     - Línea 249: nodosInventory.upsertFromHeartbeat(payload);
   □ Reiniciar servidor: npm start
   □ Conectar ESP32 → debería aparecer en /api/nodos

2️⃣  TRENES NO CARGAN:
   □ Abrir cualquier perfil
   □ Ir a TAB TRENES
   □ Crear estructura: Tren 1 (20 surcos), Tren 2 (22 surcos)
   □ GUARDAR
   □ Reload página
   □ Debería mostrar: "✅ Estructura definida"

3️⃣  NO GUARDA:
   □ Abrir DevTools (F12) → Network
   □ Intentar guardar config
   □ Ver si POST /api/config/maquinas/guardar falla
   □ Si devuelve ERROR 500 → revisar logs del servidor

🚀 DESPUÉS DE TODOS LOS FIXES:
   npm start
   Abrir: http://localhost:3000/config
   Verificar que nodos y trenes aparezcan

`);

console.log("═" + "═".repeat(40) + "\n");
