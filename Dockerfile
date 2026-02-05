# 使用官方 Node LTS（之後我們會統一用 20）
FROM node:20-slim

# 建立 app 目錄
WORKDIR /app

# 先拷貝 package 檔（有快取好處）
COPY package*.json ./

# 安裝依賴
RUN npm install --omit=dev

# 再拷貝其餘檔案
COPY . .

# Cloud Run 預設用 8080
ENV PORT=8080

# 啟動 server
CMD ["node", "index.js"]
