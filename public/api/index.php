<?php
// Entry point for the API. The real code lives outside the public folder:
// ../_private/app (when deployed) or ../../app (in the repository / local dev).
foreach ([__DIR__ . '/../_private/app/api.php', __DIR__ . '/../../app/api.php'] as $file) {
    if (is_file($file)) {
        require $file;
        exit;
    }
}
http_response_code(500);
header('Content-Type: application/json');
echo '{"error":"Server is missing its app files"}';
