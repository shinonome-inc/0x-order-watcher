FROM node:16.13
WORKDIR /app
COPY . .
RUN yarn install
RUN yarn build
# 適宜ここのポートは変更して下さい。
EXPOSE 8008
CMD [ "yarn", "start" ]
