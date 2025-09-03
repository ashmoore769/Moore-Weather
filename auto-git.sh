


#!/bin/zsh
# Simple auto-commit & push script
# Usage: ./auto-git.sh "your commit message"

if [ -z "$1" ]; then
  msg="update from $(date '+%Y-%m-%d %H:%M:%S')"
else
  msg="$1"
fi

git add -A
git commit -m "$msg"
git push origin main
#!/bin/bash

fswatch -o public/index.html public/daily.html | while read num
do
  git add .
  git commit -m "Auto-update: index.html, daily.html, server.js and more"
  git push origin main
done

