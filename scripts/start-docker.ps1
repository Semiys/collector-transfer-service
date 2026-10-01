$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envPath = Join-Path $projectDir '.env'
$imageName = 'collector-transfer-service:0.1.0'
Push-Location $projectDir
try {
    docker build -t $imageName .
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать Docker-образ.' }

    if (-not (Test-Path -LiteralPath $envPath)) {
        $generated = @(docker run --rm $imageName node -e "const c=require('node:crypto'); for (const n of ['ADMIN_ACCESS_TOKEN','OPENROUTER_KEY_ENC_KEY']) console.log(n+'='+c.randomBytes(32).toString('hex'))")
        if ($LASTEXITCODE -ne 0 -or $generated.Count -ne 2) { throw 'Не удалось создать настройки администратора.' }
        [System.IO.File]::WriteAllLines($envPath, [string[]]$generated, [System.Text.UTF8Encoding]::new($false))
        Write-Host 'Создан локальный файл .env с настройками админ-панели.'
    }

    $settings = @(Get-Content -LiteralPath $envPath -Encoding UTF8 | ForEach-Object { $_.TrimStart([char]0xFEFF) })
    $adminToken = @($settings | Where-Object { $_ -match '^ADMIN_ACCESS_TOKEN=[0-9a-f]{64}$' })
    $encryptionKey = @($settings | Where-Object { $_ -match '^OPENROUTER_KEY_ENC_KEY=[0-9a-f]{64}$' })
    if ($adminToken.Count -ne 1 -or $encryptionKey.Count -ne 1) {
        throw 'Файл .env неполный. Проверьте две строки по docs/SECOND_COMPUTER_SETUP.md.'
    }

    Write-Host ''
    Write-Host 'Откройте в браузере виртуальной машины: http://localhost:8080/admin'
    Write-Host "Админ-код для входа: $($adminToken[0].Substring('ADMIN_ACCESS_TOKEN='.Length))"
    Write-Host 'Не отправляйте этот код и файл .env в чат или Git.'
    Write-Host ''
    docker run --rm -p '127.0.0.1:8080:8080' --env-file $envPath -v 'collector-transfer-data:/app/data' $imageName
    if ($LASTEXITCODE -ne 0) { throw 'Контейнер завершился с ошибкой.' }
}
finally {
    Pop-Location
}
