FROM node:16-alpine as yarn-install

WORKDIR /usr/src/app

COPY package.json yarn.lock ./ 
RUN apk add --no-cache --virtual .build-deps git python3 make g++
RUN yarn install --frozen-lockfile
RUN apk del .build-deps
RUN yarn cache clean

FROM node:16-alpine

WORKDIR /usr/src/app
COPY . .
COPY --from=yarn-install /usr/src/app/node_modules ./node_modules
RUN yarn build

EXPOSE 8008

CMD ["yarn", "start"]
