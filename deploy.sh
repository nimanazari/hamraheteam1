#!/usr/bin/env bash
# آپلود نسخه جدید روی hamraheteam.ir و ری‌استارت سرویس (دیتابیس سرور دست نمی‌خورد)
set -e
cd "$(dirname "$0")"
tar czf /tmp/barname.tgz --exclude=node_modules --exclude=data --exclude=.claude server.js package.json students.txt public README.md
scp -P 2222 -q /tmp/barname.tgz root@45.149.78.36:/tmp/barname.tgz
ssh -p 2222 root@45.149.78.36 'cd /opt/barname-madrese && tar xzf /tmp/barname.tgz && rm /tmp/barname.tgz && systemctl restart barname-madrese && sleep 2 && curl -s http://127.0.0.1:5920/health && echo " deployed"'
