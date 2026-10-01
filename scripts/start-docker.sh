#!/bin/sh
set -eu

project_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"

image='collector-transfer-service:0.1.0'
docker build -t "$image" .

if [ ! -e .env ]; then
  umask 077
  temporary_file=$(mktemp .env.XXXXXX)
  trap 'rm -f "$temporary_file"' EXIT
  docker run --rm "$image" node -e "const c=require('node:crypto');for(const n of ['ADMIN_ACCESS_TOKEN','OPENROUTER_KEY_ENC_KEY'])console.log(n+'='+c.randomBytes(32).toString('hex'))" > "$temporary_file"
  mv "$temporary_file" .env
  trap - EXIT
  printf 'Создан локальный файл .env с настройками админ-панели.\n'
fi

if ! grep -Eq '^ADMIN_ACCESS_TOKEN=[0-9a-f]{64}$' .env ||
   ! grep -Eq '^OPENROUTER_KEY_ENC_KEY=[0-9a-f]{64}$' .env; then
  printf 'Файл .env неполный. Проверьте обе строки по инструкции docs/SECOND_COMPUTER_SETUP.md.\n' >&2
  exit 1
fi

printf '\nОткройте в браузере этой виртуальной машины: http://localhost:8080/admin\n'
printf 'Админ-код для входа: '
sed -n 's/^ADMIN_ACCESS_TOKEN=//p' .env
printf 'Не отправляйте этот код и файл .env в чат или Git.\n\n'

docker run --rm -p 127.0.0.1:8080:8080 --env-file .env \
  -v collector-transfer-data:/app/data "$image"
