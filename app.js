import fetch from 'node-fetch';
import { promises as fs } from 'fs';
import path from 'path';
import process from 'process';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';

const TEST = false;
const targetSheet = TEST ? '2022Copy' : '2022';

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
const loadSavedCredentialsIfExist = async () => {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
};

/**
 * Serializes credentials to a file comptible with GoogleAUth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
const saveCredentials = async (client) => {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
};

/**
 * Load or request or authorization to call APIs.
 *
 */
const authorize = async () => {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        return client;
    }
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
        await saveCredentials(client);
    }
    return client;
};

const getAmazonPrice = async (link) => {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const apiKey = keys?.rainforestapi?.apiKey;
    if (!apiKey) {
        console.error('Rainforest API Key not found');
        return null;
    }
    const asin = link?.replace(/.*?amazon.*?\/dp\/(.{10}?)[\?\/]?.*/, '$1');
    if (!asin) {
        return null;
    }
    const url = `https://api.rainforestapi.com/request?api_key=${apiKey}&amazon_domain=amazon.com&type=product&asin=${asin}`;

    //extract data
    let json = {};
    if (TEST) {
        const price = Math.floor(Math.random() * 1000) / 100;
        const rrp = price + 10;
        json = {
            product: {
                has_coupon: Math.floor(Math.random() * 10) > 5,
                coupon_text: 'Apply 10% off',
                buybox_winner: {
                    price: { value: price },
                    rrp: { value: rrp },
                },
            },
        };
    } else {
        json = await (await fetch(url)).json();
    }

    const currentPrice = json?.product?.buybox_winner?.price?.value || 0;
    const basePrice = json?.product?.buybox_winner?.rrp?.value || 0;
    const couponText = json?.product?.has_coupon ? json?.product?.coupon_text : '0';
    const coupon = parseInt(couponText?.replaceAll(/.*?(\d+)%.*/g, '$1'));
    const discountPrice = currentPrice * (1 - (coupon / 100));
    // console.log({ link, url, json, currentPrice, basePrice, couponText, coupon });
    return { price: discountPrice, link };
};

/**
 * Calls out to amazon to get prices and puts the lowest one in a cell
 * @see https://docs.google.com/spreadsheets/d/140m7l6kp2dGbmufbGFJ9W2N28Zcb1dkAD5Ncv80lIjk/edit
 * @param {google.auth.OAuth2} auth The authenticated Google OAuth client.
 */
const getLowestAmazonPrice = async (auth) => {
    const sheets = google.sheets({ version: 'v4', auth });
    const linksSheetResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: '140m7l6kp2dGbmufbGFJ9W2N28Zcb1dkAD5Ncv80lIjk',
        range: 'Links!A1:Z',
    });
    const targetSheetResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: '140m7l6kp2dGbmufbGFJ9W2N28Zcb1dkAD5Ncv80lIjk',
        range: `${targetSheet}!A1:Z`,
    });

    const rows = linksSheetResponse.data.values;
    const targetRows = targetSheetResponse.data.values;

    if (!rows || rows.length === 0) {
        console.log('No data found.');
        return;
    }

    const newRowData = await Promise.all(rows.map(async (row, index) => {
        const itemName = targetRows[index][1]?.replace(/=HYPERLINK\(".*?", "(.*)"\)/i, '$1');
        const rowPrices = await Promise.all(row.map(cell => getAmazonPrice(cell)));
        let lowestPrice = null;
        rowPrices.forEach((amazonPrice) => {
            if (amazonPrice === null) {
                return;
            }
            if (lowestPrice === null || amazonPrice.price < lowestPrice.price) {
                lowestPrice = { ...amazonPrice };
            }
        });
        if (lowestPrice === null) {
            //       B     C     D     E     F     G
            return [null, null, null, null, null, null];
        }
        //                        B                                  C     D     E     F          G
        return [`=HYPERLINK("${lowestPrice.link}", "${itemName}")`, null, null, null, null, lowestPrice.price];
    }));

    sheets.spreadsheets.values.update({
        spreadsheetId: '140m7l6kp2dGbmufbGFJ9W2N28Zcb1dkAD5Ncv80lIjk',
        range: `${targetSheet}!B1:G`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            range: `${targetSheet}!B1:G`,
            values: newRowData,
        },
    });

    const now = (new Date());
    const nowString = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()} ${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
    const logData = newRowData
        .filter((row) => row[0] !== null)
        .map((row) => [nowString, row[0], row[5], TEST]);

    sheets.spreadsheets.values.append({
        spreadsheetId: '140m7l6kp2dGbmufbGFJ9W2N28Zcb1dkAD5Ncv80lIjk',
        range: 'Log!A2:E',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            range: 'Log!A2:E',
            values: logData,
        },
    });
};

authorize().then(getLowestAmazonPrice).catch(console.error);
