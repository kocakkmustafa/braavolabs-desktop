// Prevents an extra console window on Windows in release. DOES NOT affect dev.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    forge_desktop_lib::run();
}
