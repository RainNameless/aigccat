#!/usr/bin/env bash
# aigccat 一键部署脚本（sub2api 风格）
#
# 用法：
#   mkdir -p aigccat-deploy && cd aigccat-deploy
#   curl -sSL https://raw.githubusercontent.com/RainNameless/aigccat/main/deploy/docker-deploy.sh | bash
#
# 做三件事：
#   1. 下载 docker-compose.allinone.yml（保存为 docker-compose.yml）
#   2. docker compose up -d 启动（首次启动容器内自动生成密钥；
#      初始账号固定 admin / aigccat，并自动种入 4 个示例资产 —— 不需要预先配置 .env）
#   3. 等就绪后打印初始账号密码
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/RainNameless/aigccat/main"
COMPOSE_SRC="$REPO_RAW/docker-compose.allinone.yml"
DIR="${1:-aigccat-deploy}"

command -v docker >/dev/null 2>&1 || { echo "错误：未安装 Docker（需要 20.10+）"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "错误：未安装 Docker Compose v2"; exit 1; }

mkdir -p "$DIR" && cd "$DIR"

echo "── 1/3 下载 compose 配置…"
if [ ! -f docker-compose.yml ]; then
  curl -fsSL "$COMPOSE_SRC" -o docker-compose.yml
  echo "    已保存 $(pwd)/docker-compose.yml"
else
  echo "    已存在 docker-compose.yml，沿用（删除它可重新获取最新版）"
fi

echo "── 2/3 启动容器（首次会自动生成密钥并种入示例资产）…"
docker compose up -d

echo "── 3/3 等待就绪（最长 5 分钟）…"
for i in $(seq 1 60); do
  status=$(docker compose ps --format '{{.Health}}' 2>/dev/null | head -1 || true)
  if [ "$status" = "healthy" ]; then
    echo "    容器已就绪"
    break
  fi
  [ "$i" = "60" ] && { echo "    超时：请用 docker compose logs -f aigccat 查看进度"; }
  sleep 5
done

echo
echo "  ────────────────────────────────────────────────"
echo "   aigccat 部署完成"
echo "   访问地址：http://localhost:8080"
docker compose logs aigccat 2>/dev/null | grep -A 2 "初始账号" | sed 's/^/   /' || true
echo "   （默认账号 admin / 密码 aigccat；公网部署请尽快改掉，别一直用默认值）"
echo "  ────────────────────────────────────────────────"
echo
echo "常用命令："
echo "  docker compose logs -f aigccat     # 看日志"
echo "  docker compose down                 # 停止（数据保留在卷 aigccat-allinone_aigccat-data）"
echo "  docker compose pull && docker compose up -d   # 升级到最新镜像"
