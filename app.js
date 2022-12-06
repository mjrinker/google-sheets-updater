import fetch from 'node-fetch';
import { promises as fsPromise } from 'fs';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';
import chrome from 'selenium-webdriver/chrome.js';
import chromedriver from 'chromedriver';
import { Builder, By, until } from 'selenium-webdriver';

const TEST = false;
const targetSheet = TEST ? '2022Test' : '2022';

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
		const content = await fsPromise.readFile(TOKEN_PATH);
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
	const content = await fsPromise.readFile(CREDENTIALS_PATH);
	const keys = JSON.parse(content);
	const key = keys.installed || keys.web;
	const payload = JSON.stringify({
		type: 'authorized_user',
		client_id: key.client_id,
		client_secret: key.client_secret,
		refresh_token: client.credentials.refresh_token,
	});
	await fsPromise.writeFile(TOKEN_PATH, payload);
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

const safeFindElementByCSS = async (selector, waitTime = 500) => {
	try {
		return await driver.wait(until.elementLocated(By.css(selector)), waitTime);
	} catch (error) {
		console.warn(`Could not find element by CSS for "${selector}" due to "${error.message.replaceAll(/\n+/g, ' ')}"`);
		return null;
	}
};

const makeElementVisible = async (selector) => {
	try {
		await driver.executeScript(`document.querySelector('${selector}').style.position = 'static';`);
		await driver.executeScript(`document.querySelector('${selector}').style.opacity = '1';`);
		await driver.executeScript(`document.querySelector('${selector}').style.display = 'initial';`);
	} catch (error) {
		console.log('scat', error.name, error.message);
		if (error.message.toLowerCase().includes('javascript')) {
			console.warn('Error making element visible', error.message);
		} else {
			throw error;
		}
	}
};

const scrapeAmazonProductPage = async (url) => {
	await driver.get(url);

	let currentPrice = 0;
	let basePrice = 0;
	let couponText = '0%';
	try {
		const currentPriceSelector1 = '#corePriceDisplay_desktop_feature_div .a-offscreen';
		const currentPriceSelector2 = '#corePrice_desktop tr:nth-child(2) .a-price .a-offscreen';
		const basePriceSelector1 = '#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen';
		const basePriceSelector2 = '#corePrice_desktop tr:nth-child(1) .a-price .a-offscreen';
		const couponTextSelector = '[id^="couponText"]';

		const currentPriceEl1 = await safeFindElementByCSS(currentPriceSelector1);
		const currentPriceEl2 = await safeFindElementByCSS(currentPriceSelector2);
		const basePriceEl1 = await safeFindElementByCSS(basePriceSelector1);
		const basePriceEl2 = await safeFindElementByCSS(basePriceSelector2);
		const couponTextEl = await safeFindElementByCSS(couponTextSelector);

		if (currentPriceEl1) {
			await makeElementVisible(currentPriceSelector1);
		}

		if (basePriceEl1) {
			await makeElementVisible(basePriceSelector1);
		}

		const currentPriceText = await currentPriceEl1?.getText();
		const basePriceText = await basePriceEl1?.getText();
		currentPrice = parseFloat(currentPriceText?.replaceAll(/[^\d\.]/g, ''));
		basePrice = parseFloat(basePriceText?.replaceAll(/[^\d\.]/g, ''));
		if ((!currentPriceEl1 || Number.isNaN(currentPrice)) && currentPriceEl2) {
			await makeElementVisible(currentPriceSelector2);
			currentPrice = parseFloat((await currentPriceEl2?.getText())?.replaceAll(/[^\d\.]/g, ''));
		}
		if ((!basePriceEl1 || Number.isNaN(basePrice)) && basePriceEl2) {
			await makeElementVisible(basePriceSelector2);
			basePrice = parseFloat((await basePriceEl2?.getText())?.replaceAll(/[^\d\.]/g, ''));
		}
		couponText = await couponTextEl?.getText();
	} catch (error) {
		console.warn(error.message, 'continuing...');
	}

	const json = {
		product: {
			has_coupon: !!couponText,
			coupon_text: couponText,
			buybox_winner: {
				price: { value: currentPrice || 0 },
				rrp: { value: basePrice || currentPrice || 0 },
			},
		},
	};

	return json;
};

const getAmazonPrice = async (link) => {
	const content = await fsPromise.readFile(CREDENTIALS_PATH);
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
	let response = {};
	let json = {};
	console.log('Requesting Amazon product data for ASIN', asin);
	if (TEST) {
		const price = Math.floor(Math.random() * 1000) / 100;
		const rrp = price + 10;
		response = { status: 429 };
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
		try {
			response = await fetch(url);
			json = await response.json();
			json = await (await fetch(url)).json();
		} catch (error) {
			console.error(error);
			response = { status: 500 };
		}
	}

	if (response.status >= 400 || !json?.product) {
		console.warn('Request failed:', response.status);
		console.log('Scraping Amazon product page instead');
		json = await scrapeAmazonProductPage(link);
	}

	const currentPrice = json?.product?.buybox_winner?.price?.value || 0;
	const basePrice = json?.product?.buybox_winner?.rrp?.value || 0;
	const couponText = json?.product?.has_coupon ? json?.product?.coupon_text : '0%';
	const coupon = parseInt(couponText?.replaceAll(/.*?(\d+)%.*/g, '$1'));
	const discountPrice = currentPrice * (1 - (coupon / 100));
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

	const newRowData = [];
	let index = 0;
	for (let row of rows) {
		const itemName = targetRows[index][1]?.replace(/=HYPERLINK\(".*?", "(.*)"\)/i, '$1');
		const rowPrices = [];
		for (let cell of row) {
			rowPrices.push(await getAmazonPrice(cell));
		}
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
			//                B     C     D     E     F     G
			newRowData.push([null, null, null, null, null, null]);
		} else {
			//                                 B                                  C     D     E     F          G
			newRowData.push([`=HYPERLINK("${lowestPrice.link}", "${itemName}")`, null, null, null, null, lowestPrice.price]);
		}
		index += 1;
	}

	sheets.spreadsheets.values.update({
		spreadsheetId: '140m7l6kp2dGbmufbGFJ9W2N28Zcb1dkAD5Ncv80lIjk',
		range: `${targetSheet}!B1:G`,
		valueInputOption: 'USER_ENTERED',
		requestBody: {
			range: `${targetSheet}!B1:G`,
			values: newRowData,
		},
	});

	sheets.spreadsheets.values.clear({
		spreadsheetId: '140m7l6kp2dGbmufbGFJ9W2N28Zcb1dkAD5Ncv80lIjk',
		range: `${targetSheet}!I2:I`,
		requestBody: {},
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

const screen = {
	width: 640,
	height: 480,
};

// chrome.setDefaultService(new chrome.ServiceBuilder(chromedriver.path).build());

let driver = new Builder()
	.forBrowser('chrome')
	.setChromeOptions(new chrome.Options()
		.headless()
		.windowSize(screen)
	)
	// .withCapabilities(Capabilities.chrome())
	.build();

authorize().then(async (auth) => {
	await getLowestAmazonPrice(auth);
	await driver.quit();
}).catch((error) => {
	if (error.message === 'invalid_grant') {
		fs.unlinkSync('./token.json');
		authorize().then(async (auth) => {
			await getLowestAmazonPrice(auth);
			await driver.quit();
		}).catch((error) => {
			console.error(error);
			driver.quit();
		});
	} else {
		console.error(error);
		driver.quit();
	}
});
