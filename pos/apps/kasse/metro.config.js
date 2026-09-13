// Metro fuer ein npm-Workspaces-Monorepo: die App liegt in apps/kasse, die
// Domaenenlogik in packages/core. Ohne diese Konfiguration findet der Bundler
// den Kern nicht und laedt ihn auch nicht neu, wenn er sich aendert.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Aenderungen im Kern sollen den Bundler ebenfalls neu laden lassen.
config.watchFolders = [workspaceRoot];

// Beide node_modules-Ebenen, App zuerst.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// Verhindert, dass Metro ueber die Ordnerkette hinaus sucht und dabei zwei
// Kopien von React einsammelt - der klassische Fehler im Monorepo.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
