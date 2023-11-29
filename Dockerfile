FROM node:16.13
WORKDIR /app
COPY . .
RUN npm install
RUN yarn build
USER nonroot
# 適宜ここのポートは変更して下さい。
EXPOSE 8008
CMD [ "yarn", "start" ]