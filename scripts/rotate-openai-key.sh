#!/usr/bin/env bash
# OpenAI API 키 교체: 로컬 .env + Railway(iLaw-backend / production)에 한 번에 적용한다.
#
#   npm run secrets:openai
#
# - 키는 터미널에서 가려진 입력(read -s)으로 받는다. 화면·셸 히스토리·프로세스 인자에 남지 않는다.
# - 적용 전에 OpenAI에 실제로 인증해 보고(GET /v1/models) 유효한 키만 반영한다.
# - Railway에는 --stdin 으로 넘겨 값이 `ps` 에 노출되지 않게 한다.
# - .env 는 OPENAI_API_KEY 줄만 바꾸고 나머지는 그대로 둔다. 백업 파일을 만들지 않는다(옛 키가 남지 않게).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
RAILWAY_SERVICE="${RAILWAY_SERVICE:-iLaw-backend}"
RAILWAY_ENV="${RAILWAY_ENV:-production}"
VAR_NAME="OPENAI_API_KEY"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

command -v railway >/dev/null || { red "railway CLI가 없습니다. brew install railway"; exit 1; }
command -v curl >/dev/null || { red "curl이 필요합니다."; exit 1; }
[ -f "$ENV_FILE" ] || { red ".env 가 없습니다: $ENV_FILE"; exit 1; }

echo "OpenAI API 키 교체 — 로컬 .env + Railway($RAILWAY_SERVICE / $RAILWAY_ENV)"
echo
read -r -s -p "새 OPENAI_API_KEY 입력 (화면에 표시되지 않음): " KEY
echo
read -r -s -p "한 번 더 입력: " KEY2
echo

[ -n "$KEY" ] || { red "빈 값입니다."; exit 1; }
[ "$KEY" = "$KEY2" ] || { red "두 입력이 다릅니다."; exit 1; }
KEY="${KEY//[[:space:]]/}"
case "$KEY" in
  sk-*) ;;
  *) red "OpenAI 키는 'sk-' 로 시작해야 합니다."; exit 1 ;;
esac
MASKED="${KEY:0:7}…${KEY: -4}"
dim "입력된 키: $MASKED (${#KEY}자)"

echo
printf '1/3 OpenAI 인증 확인… '
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
  -H "Authorization: Bearer $KEY" https://api.openai.com/v1/models || true)"
if [ "$STATUS" != "200" ]; then
  red "실패 (HTTP $STATUS). 키가 유효하지 않거나 네트워크 문제입니다. 아무것도 변경하지 않았습니다."
  exit 1
fi
green "OK"

printf '2/3 로컬 .env 갱신… '
TMP="$(mktemp "$ENV_FILE.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
if grep -q "^$VAR_NAME=" "$ENV_FILE"; then
  # 값에 어떤 문자가 오든 안전하게: 해당 줄만 통째로 교체
  awk -v k="$VAR_NAME" -v v="$KEY" 'BEGIN{done=0} index($0,k"=")==1 && !done {print k"="v; done=1; next} {print}' \
    "$ENV_FILE" > "$TMP"
else
  cat "$ENV_FILE" > "$TMP"
  printf '\n%s=%s\n' "$VAR_NAME" "$KEY" >> "$TMP"
fi
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT
green "OK ($ENV_FILE)"

printf '3/3 Railway 변수 설정 (재배포 트리거)… '
if printf '%s' "$KEY" | railway variables set "$VAR_NAME" --stdin --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENV" >/dev/null; then
  green "OK ($RAILWAY_SERVICE / $RAILWAY_ENV)"
else
  red "실패. 로컬 .env 는 이미 갱신됐습니다. 'railway login' / 'railway link' 상태를 확인한 뒤 다시 실행하세요."
  exit 1
fi

unset KEY KEY2

echo
green "완료. 새 키($MASKED)가 로컬과 Railway 양쪽에 적용됐습니다."
echo "다음 확인:"
echo "  - 로컬 dev 서버(nodemon)는 .env 를 다시 읽지 않으니 재시작하세요."
echo "  - Railway 재배포 상태: railway status   /   로그: railway logs"
echo "  - 옛 키는 OpenAI 대시보드(platform.openai.com/api-keys)에서 폐기(revoke)하세요."
