//! Presentation only. Locale selection never changes approval authority.
pub const LOCALES: [&str; 8] = ["en", "tr", "es-419", "pt-BR", "de", "fr", "ja", "ar"];
fn index(locale: &str) -> usize { LOCALES.iter().position(|v| *v == locale).unwrap_or(0) }
pub fn message<'a>(locale: &str, key: &'a str) -> &'a str {
    let translations: Option<[&str; 8]> = match key {
        "title" => Some(["Braavolabs — approval required", "Braavolabs — onay gerekli", "Braavolabs — se requiere aprobación", "Braavolabs — aprovação necessária", "Braavolabs — Zustimmung erforderlich", "Braavolabs — approbation requise", "Braavolabs — 承認が必要です", "Braavolabs — الموافقة مطلوبة"]),
        "intro" => Some(["Braavolabs is asking to run this action:", "Braavolabs bu eylemi çalıştırmak için onay istiyor:", "Braavolabs solicita ejecutar esta acción:", "O Braavolabs solicita executar esta ação:", "Braavolabs bittet um Erlaubnis für diese Aktion:", "Braavolabs demande à exécuter cette action :", "Braavolabs が次の操作の実行を求めています：", "يطلب Braavolabs تنفيذ هذا الإجراء:"]),
        "question" => Some(["Allow it to proceed?", "Devam etmesine izin verilsin mi?", "¿Permitir que continúe?", "Permitir que prossiga?", "Fortfahren erlauben?", "Autoriser la poursuite ?", "続行を許可しますか？", "هل تسمح بالمتابعة؟"]),
        "Allow" => Some(["Allow", "İzin ver", "Permitir", "Permitir", "Erlauben", "Autoriser", "許可", "السماح"]),
        "Deny" => Some(["Deny", "Reddet", "Denegar", "Negar", "Ablehnen", "Refuser", "拒否", "رفض"]),
        "Action" => Some(["Action", "Eylem", "Acción", "Ação", "Aktion", "Action", "操作", "الإجراء"]),
        "Server" => Some(["Server", "Sunucu", "Servidor", "Servidor", "Server", "Serveur", "サーバー", "الخادم"]),
        "Executable" => Some(["Executable", "Çalıştırılabilir dosya", "Ejecutable", "Executável", "Programmdatei", "Exécutable", "実行ファイル", "الملف التنفيذي"]),
        "Launch argv" | "argv" => Some(["Launch argv", "Başlatma argümanları", "Argumentos de inicio", "Argumentos de inicialização", "Startargumente", "Arguments de lancement", "起動引数", "وسائط التشغيل"]),
        "Directory" | "cwd" => Some(["Directory", "Dizin", "Directorio", "Diretório", "Verzeichnis", "Dossier", "ディレクトリ", "المجلد"]),
        "Tool" => Some(["Tool", "Araç", "Herramienta", "Ferramenta", "Werkzeug", "Outil", "ツール", "الأداة"]),
        "Arguments" | "args" => Some(["Arguments", "Argümanlar", "Argumentos", "Argumentos", "Argumente", "Arguments", "引数", "الوسائط"]),
        "Provider" | "Vendor" => Some(["Provider", "Sağlayıcı", "Proveedor", "Provedor", "Anbieter", "Fournisseur", "プロバイダー", "المزوّد"]),
        "Path" => Some(["Path", "Yol", "Ruta", "Caminho", "Pfad", "Chemin", "パス", "المسار"]),
        "mcp_scope" => Some([
            "Local OS process, inherited environment snapshot and ordinary filesystem/network access; this is not a sandbox or a verified cloud account. Single use; expires in 120 seconds.",
            "Yerel işletim sistemi işlemi; devralınmış ortam anlık görüntüsü ve normal dosya/ağ erişimi. Sandbox veya doğrulanmış bulut hesabı değildir. Tek kullanım; 120 saniyede sona erer.",
            "Proceso local del sistema, entorno heredado congelado y acceso normal a archivos y red; no es un entorno aislado ni una cuenta de nube verificada. Un solo uso; vence en 120 segundos.",
            "Processo local do sistema, ambiente herdado congelado e acesso normal a arquivos e rede; não é um sandbox nem uma conta de nuvem verificada. Uso único; expira em 120 segundos.",
            "Lokaler Betriebssystemprozess mit eingefrorener geerbter Umgebung und normalem Datei-/Netzwerkzugriff; keine Sandbox und kein verifiziertes Cloudkonto. Einmalig; läuft nach 120 Sekunden ab.",
            "Processus local avec environnement hérité figé et accès normal aux fichiers et au réseau ; ni bac à sable ni compte cloud vérifié. Usage unique ; expire dans 120 secondes.",
            "ローカルOSプロセスです。継承環境のスナップショットと通常のファイル・ネットワークアクセスを使用します。サンドボックスや確認済みクラウドアカウントではありません。1回限り、120秒で失効します。",
            "عملية محلية للنظام مع لقطة ثابتة للبيئة الموروثة والوصول المعتاد للملفات والشبكة؛ ليست بيئة معزولة أو حساب سحابي موثّق. استخدام واحد وتنتهي خلال 120 ثانية."]),
        _ => None,
    };
    translations.map(|values| values[index(locale)]).unwrap_or(key)
}
pub fn body(locale: &str, enforced: &str) -> String {
    enforced.lines().map(|line| {
        if line == message("en", "mcp_scope") { return message(locale, "mcp_scope").to_string(); }
        if let Some((label, value)) = line.split_once(": ") {
            // Only labels change. The complete JSON-quoted effective values do not.
            format!("{}: {}", message(locale, label), value)
        } else { line.to_string() }
    }).collect::<Vec<_>>().join("\n")
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn all_locales_have_native_buttons_and_do_not_rewrite_arguments() {
        for locale in LOCALES {
            assert_ne!(message(locale, "title"), "title");
            assert_ne!(message(locale, "intro"), "intro");
            let input = "Arguments: {\"value\":\"Allow: ABC \\n 日本語\"}";
            assert!(body(locale, input).ends_with("{\"value\":\"Allow: ABC \\n 日本語\"}"));
        }
    }
}
