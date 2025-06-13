#!/bin/bash

fswatch -o public/index.html public/daily.html | while read num
do
  git add .
  git commit -m "Auto-update: index.html, daily.html, server.js and more"
  git push origin main
done

