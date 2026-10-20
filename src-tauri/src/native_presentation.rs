//! Presentation only. Locale selection never changes approval authority.
pub const LOCALES: [&str; 14] = ["en", "tr", "es-419", "pt-BR", "de", "fr", "ja", "ar", "it", "ko", "id", "pl", "hi", "zh-Hans"];
fn index(locale: &str) -> usize { LOCALES.iter().position(|v| *v == locale).unwrap_or(0) }
pub fn message<'a>(locale: &str, key: &'a str) -> &'a str {
    let translations: Option<[&str; 14]> = match key {
        "title" => Some(["Braavolabs — approval required", "Braavolabs — onay gerekli", "Braavolabs — se requiere aprobación", "Braavolabs — aprovação necessária", "Braavolabs — Zustimmung erforderlich", "Braavolabs — approbation requise", "Braavolabs — 承認が必要です", "Braavolabs — الموافقة مطلوبة", "Braavolabs — approvazione necessaria", "Braavolabs — 승인 필요", "Braavolabs — persetujuan diperlukan", "Braavolabs — wymagana zgoda", "Braavolabs — अनुमोदन आवश्यक", "Braavolabs — 需要审批"]),
        "intro" => Some(["Braavolabs is asking to run this action:", "Braavolabs bu eylemi çalıştırmak için onay istiyor:", "Braavolabs solicita ejecutar esta acción:", "O Braavolabs solicita executar esta ação:", "Braavolabs bittet um Erlaubnis für diese Aktion:", "Braavolabs demande à exécuter cette action :", "Braavolabs が次の操作の実行を求めています：", "يطلب Braavolabs تنفيذ هذا الإجراء:", "Braavolabs chiede di eseguire questa azione:", "Braavolabs가 이 작업의 실행 승인을 요청합니다:", "Braavolabs meminta izin untuk menjalankan tindakan ini:", "Braavolabs prosi o zgodę na wykonanie działania:", "Braavolabs यह कार्रवाई चलाने की अनुमति माँग रहा है:", "Braavolabs 请求执行以下操作："]),
        "question" => Some(["Allow it to proceed?", "Devam etmesine izin verilsin mi?", "¿Permitir que continúe?", "Permitir que prossiga?", "Fortfahren erlauben?", "Autoriser la poursuite ?", "続行を許可しますか？", "هل تسمح بالمتابعة؟", "Consentire di procedere?", "계속 진행하도록 허용할까요?", "Izinkan untuk melanjutkan?", "Zezwolić na kontynuowanie?", "क्या आगे बढ़ने की अनुमति दें?", "是否允许继续？"]),
        "Allow" => Some(["Allow", "İzin ver", "Permitir", "Permitir", "Erlauben", "Autoriser", "許可", "السماح", "Consenti", "허용", "Izinkan", "Zezwól", "अनुमति दें", "允许"]),
        "Deny" => Some(["Deny", "Reddet", "Denegar", "Negar", "Ablehnen", "Refuser", "拒否", "رفض", "Nega", "거부", "Tolak", "Odmów", "अस्वीकार करें", "拒绝"]),
        "Action" => Some(["Action", "Eylem", "Acción", "Ação", "Aktion", "Action", "操作", "الإجراء", "Azione", "작업", "Tindakan", "Działanie", "कार्रवाई", "操作"]),
        "Server" => Some(["Server", "Sunucu", "Servidor", "Servidor", "Server", "Serveur", "サーバー", "الخادم", "Server", "서버", "Server", "Serwer", "सर्वर", "服务器"]),
        "Executable" => Some(["Executable", "Çalıştırılabilir dosya", "Ejecutable", "Executável", "Programmdatei", "Exécutable", "実行ファイル", "الملف التنفيذي", "Eseguibile", "실행 파일", "Executable", "Plik wykonywalny", "निष्पादन योग्य फ़ाइल", "可执行文件"]),
        "Launch argv" | "argv" => Some(["Launch argv", "Başlatma argümanları", "Argumentos de inicio", "Argumentos de inicialização", "Startargumente", "Arguments de lancement", "起動引数", "وسائط التشغيل", "Argomenti di avvio", "실행 인수", "Argumen peluncuran", "Argumenty uruchomienia", "शुरू करने के आर्ग्युमेंट", "启动参数"]),
        "Directory" | "cwd" => Some(["Directory", "Dizin", "Directorio", "Diretório", "Verzeichnis", "Dossier", "ディレクトリ", "المجلد", "Cartella", "디렉터리", "Direktori", "Katalog", "डायरेक्टरी", "目录"]),
        "Tool" => Some(["Tool", "Araç", "Herramienta", "Ferramenta", "Werkzeug", "Outil", "ツール", "الأداة", "Strumento", "도구", "Alat", "Narzędzie", "टूल", "工具"]),
        "Arguments" | "args" => Some(["Arguments", "Argümanlar", "Argumentos", "Argumentos", "Argumente", "Arguments", "引数", "الوسائط", "Argomenti", "인수", "Argumen", "Argumenty", "आर्ग्युमेंट", "参数"]),
        "Provider" | "Vendor" => Some(["Provider", "Sağlayıcı", "Proveedor", "Provedor", "Anbieter", "Fournisseur", "プロバイダー", "المزوّد", "Fornitore", "공급업체", "Penyedia", "Dostawca", "प्रदाता", "提供商"]),
        "Path" => Some(["Path", "Yol", "Ruta", "Caminho", "Pfad", "Chemin", "パス", "المسار", "Percorso", "경로", "Jalur", "Ścieżka", "पथ", "路径"]),
        "mcp_scope" => Some(["Local OS process, inherited environment snapshot and ordinary filesystem/network access; this is not a sandbox or a verified cloud account. Single use; expires in 120 seconds.", "Yerel işletim sistemi işlemi; devralınmış ortam anlık görüntüsü ve normal dosya/ağ erişimi. Sandbox veya doğrulanmış bulut hesabı değildir. Tek kullanım; 120 saniyede sona erer.", "Proceso local del sistema, entorno heredado congelado y acceso normal a archivos y red; no es un entorno aislado ni una cuenta de nube verificada. Un solo uso; vence en 120 segundos.", "Processo local do sistema, ambiente herdado congelado e acesso normal a arquivos e rede; não é um sandbox nem uma conta de nuvem verificada. Uso único; expira em 120 segundos.", "Lokaler Betriebssystemprozess mit eingefrorener geerbter Umgebung und normalem Datei-/Netzwerkzugriff; keine Sandbox und kein verifiziertes Cloudkonto. Einmalig; läuft nach 120 Sekunden ab.", "Processus local avec environnement hérité figé et accès normal aux fichiers et au réseau ; ni bac à sable ni compte cloud vérifié. Usage unique ; expire dans 120 secondes.", "ローカルOSプロセスです。継承環境のスナップショットと通常のファイル・ネットワークアクセスを使用します。サンドボックスや確認済みクラウドアカウントではありません。1回限り、120秒で失効します。", "عملية محلية للنظام مع لقطة ثابتة للبيئة الموروثة والوصول المعتاد للملفات والشبكة؛ ليست بيئة معزولة أو حساب سحابي موثّق. استخدام واحد وتنتهي خلال 120 ثانية.", "Processo locale del sistema operativo, con istantanea dell'ambiente ereditato e normale accesso a file e rete; non è una sandbox né un account cloud verificato. Monouso; scade dopo 120 secondi.", "로컬 OS 프로세스로, 상속된 환경의 스냅샷과 일반 파일 및 네트워크 접근 권한을 사용합니다. 샌드박스나 확인된 클라우드 계정이 아닙니다. 일회용이며 120초 후 만료됩니다.", "Proses OS lokal dengan snapshot lingkungan yang diwarisi serta akses file dan jaringan biasa; bukan sandbox atau akun cloud terverifikasi. Sekali pakai; kedaluwarsa dalam 120 detik.", "Lokalny proces systemu z migawką odziedziczonego środowiska i zwykłym dostępem do plików oraz sieci; nie jest to sandbox ani zweryfikowane konto w chmurze. Jednorazowe; wygasa po 120 sekundach.", "स्थानीय OS प्रक्रिया, विरासत में मिले परिवेश के स्नैपशॉट और सामान्य फ़ाइल व नेटवर्क पहुँच के साथ; यह sandbox या सत्यापित क्लाउड खाता नहीं है। एक बार उपयोग; 120 सेकंड में समाप्त।", "本地操作系统进程，使用继承环境的快照及常规文件和网络访问权限；并非沙箱或已验证的云账户。仅限单次使用，120 秒后失效。"]),
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
            assert_ne!(message(locale, "Allow"), "Deny");
            assert_ne!(message(locale, "Allow"), message(locale, "Deny"));
            assert!(message(locale, "mcp_scope").contains("120"));
            let input = "Arguments: {\"value\":\"Allow: ABC \\n 日本語\"}";
            assert!(body(locale, input).ends_with("{\"value\":\"Allow: ABC \\n 日本語\"}"));
        }
    }
    #[test] fn unknown_locale_uses_english_and_unknown_labels_remain_verbatim() {
        assert_eq!(message("zh-Hant", "title"), message("en", "title"));
        assert_eq!(message("unknown", "Allow"), "Allow");
        let input = "Unknown: {\"secret\":\"path: /tmp/日本語\"}\nargv: [\"Allow: value\",\"رفض\"]";
        for locale in LOCALES {
            let output = body(locale, input);
            assert!(output.starts_with("Unknown: {\"secret\":\"path: /tmp/日本語\"}\n"));
            assert!(output.ends_with("[\"Allow: value\",\"رفض\"]"));
        }
    }
}
