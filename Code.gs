const STORE_EMAIL = "tswelopeleleroylemaoana@gmail.com";
const SPREADSHEET_PROPERTY = "MALKAH_ORDERS_SPREADSHEET_ID";
const ORDER_HEADERS = [
  "Order ID",
  "Created at",
  "Status",
  "Store email status",
  "Customer email status",
  "Customer name",
  "Customer email",
  "Customer phone",
  "Town / city",
  "Delivery address",
  "Postal code",
  "Items",
  "Hair subtotal (ZAR)",
  "Delivery fee"
];
const CONTACT_HEADERS = [
  "Message ID",
  "Created at",
  "Store email status",
  "Customer email status",
  "Customer name",
  "Customer email",
  "Message"
];
const CUSTOMER_HEADERS = [
  "Customer email",
  "Customer name",
  "Phone",
  "Town / city",
  "Delivery address",
  "Postal code",
  "First seen",
  "Last updated",
  "Last order ID",
  "Last message ID"
];
const PRODUCTS = {
  "polished-bob": { name: "The Polished Bob", price: 7000 },
  "sleek-straight": { name: "The Sleek Straight", price: 8000 },
  "classic-bob": { name: "The Classic Bob", price: 3000 },
  "full-curl": { name: "The Full Curl", price: 8000 },
  "long-straight": { name: "The Long Straight", price: 2500 }
};

function setupMalkahHair() {
  const properties = PropertiesService.getScriptProperties();
  let spreadsheetId = properties.getProperty(SPREADSHEET_PROPERTY);
  let spreadsheet;

  if (spreadsheetId) {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } else {
    spreadsheet = SpreadsheetApp.create("Malkah Hair customer orders");
    properties.setProperty(SPREADSHEET_PROPERTY, spreadsheet.getId());
  }

  let sheet = spreadsheet.getSheetByName("Orders");
  if (!sheet) sheet = spreadsheet.insertSheet("Orders");
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(ORDER_HEADERS);
    sheet.setFrozenRows(1);
  }
  let contacts = spreadsheet.getSheetByName("Contact messages");
  if (!contacts) contacts = spreadsheet.insertSheet("Contact messages");
  if (contacts.getLastRow() === 0) {
    contacts.appendRow(CONTACT_HEADERS);
    contacts.setFrozenRows(1);
  }
  let customers = spreadsheet.getSheetByName("Customers");
  const shouldMigrateCustomers = !customers || customers.getLastRow() <= 1;
  if (!customers) customers = spreadsheet.insertSheet("Customers");
  if (customers.getLastRow() === 0) {
    customers.appendRow(CUSTOMER_HEADERS);
    customers.setFrozenRows(1);
  }
  if (shouldMigrateCustomers) migrateExistingCustomers_(spreadsheet);

  const defaultSheet = spreadsheet.getSheetByName("Sheet1");
  if (defaultSheet && spreadsheet.getSheets().length > 1 && defaultSheet.getLastRow() === 0) {
    spreadsheet.deleteSheet(defaultSheet);
  }
  return spreadsheet.getUrl();
}

function doGet() {
  return ContentService
    .createTextOutput("Malkah Hair order service is online. Submit orders and contact messages through the website.")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(event) {
  let payload;
  const requestId = event && event.parameter && event.parameter.requestId;
  try {
    if (!event || !event.parameter || typeof event.parameter.payload !== "string" ||
        typeof requestId !== "string" || !/^[A-Za-z0-9-]{8,80}$/.test(requestId)) {
      throw new Error("Missing or invalid submission.");
    }
    payload = JSON.parse(event.parameter.payload);
    if (!payload || payload.id !== requestId) throw new Error("Submission ID mismatch.");
    const result = payload.type === "contact"
      ? storeAndEmailContact_(validateContact_(payload))
      : storeAndEmailOrder_(validateOrder_(payload));
    return response_(result, requestId);
  } catch (error) {
    console.error(error);
    return response_({ ok: false, error: "The submission could not be processed. Please retry or contact the store." }, requestId);
  }
}

function validateOrder_(payload) {
  if (!payload || typeof payload.id !== "string" || !/^[A-Za-z0-9-]{8,80}$/.test(payload.id)) {
    throw new Error("Invalid order ID.");
  }
  const customer = payload.customer || {};
  const required = ["name", "email", "phone", "city", "address", "postalCode"];
  required.forEach(function (field) {
    if (typeof customer[field] !== "string" || !customer[field].trim() || customer[field].length > 500) {
      throw new Error("Missing or invalid customer details.");
    }
  });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    throw new Error("Invalid customer email.");
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > 20) {
    throw new Error("Invalid order items.");
  }

  const items = payload.items.map(function (item) {
    const product = item && PRODUCTS[item.productId];
    if (!product || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new Error("Invalid product or quantity.");
    }
    return {
      productId: item.productId,
      name: product.name,
      unitPrice: product.price,
      quantity: item.quantity
    };
  });
  const total = items.reduce(function (sum, item) {
    return sum + item.unitPrice * item.quantity;
  }, 0);
  if (!Number.isSafeInteger(total) || total < 1) throw new Error("Invalid order total.");

  return {
    id: payload.id,
    createdAt: new Date().toISOString(),
    customer: {
      name: customer.name.trim(),
      email: customer.email.trim(),
      phone: customer.phone.trim(),
      city: customer.city.trim(),
      address: customer.address.trim(),
      postalCode: customer.postalCode.trim()
    },
    items: items,
    total: total
  };
}

function validateContact_(payload) {
  if (!payload || typeof payload.id !== "string" || !/^[A-Za-z0-9-]{8,80}$/.test(payload.id)) {
    throw new Error("Invalid message ID.");
  }
  const customer = payload.customer || {};
  if (typeof customer.name !== "string" || !customer.name.trim() || customer.name.length > 200 ||
      typeof customer.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) ||
      typeof customer.message !== "string" || !customer.message.trim() || customer.message.length > 5000) {
    throw new Error("Missing or invalid contact details.");
  }
  return {
    id: payload.id,
    createdAt: new Date().toISOString(),
    name: customer.name.trim(),
    email: customer.email.trim(),
    message: customer.message.trim()
  };
}

function storeAndEmailOrder_(order) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_PROPERTY);
    if (!spreadsheetId) throw new Error("Run setupMalkahHair before accepting orders.");

    const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName("Orders");
    if (!sheet) throw new Error("Orders sheet is missing. Run setupMalkahHair again.");
    const lastRow = sheet.getLastRow();
    let rowNumber = 0;
    let duplicate = false;
    let adminEmailSent = false;
    let customerEmailSent = false;

    if (lastRow > 1) {
      const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
      for (let index = 0; index < ids.length; index += 1) {
        if (ids[index][0] === order.id) {
          rowNumber = index + 2;
          duplicate = true;
          const existing = sheet.getRange(rowNumber, 4, 1, 2).getValues()[0];
          adminEmailSent = existing[0] === "sent" || existing[0] === "saved_locally";
          customerEmailSent = existing[1] === "sent" || existing[1] === "saved_locally";
          break;
        }
      }
    }

    if (!rowNumber) {
      checkSubmissionRate_(order.customer.email);
      rowNumber = lastRow + 1;
      sheet.getRange(rowNumber, 1, 1, ORDER_HEADERS.length).setValues([[
        order.id,
        order.createdAt,
        "pending",
        "pending",
        "pending",
        safeCell_(order.customer.name),
        safeCell_(order.customer.email),
        safeCell_(order.customer.phone),
        safeCell_(order.customer.city),
        safeCell_(order.customer.address),
        safeCell_(order.customer.postalCode),
        JSON.stringify(order.items),
        order.total,
        "Confirm separately"
      ]]);
      sheet.getRange(rowNumber, 2).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    }

    upsertCustomer_(order.customer, { orderId: order.id });

    if (!adminEmailSent) {
      try {
        MailApp.sendEmail({
          to: STORE_EMAIL,
          subject: "New Malkah Hair order request " + order.id,
          body: orderEmailBody_(order, true)
        });
        sheet.getRange(rowNumber, 4).setValue("sent");
        adminEmailSent = true;
      } catch (error) {
        console.error("Could not send the store order notification.", error);
        sheet.getRange(rowNumber, 4).setValue("email failed");
      }
    }

    if (!customerEmailSent) {
      try {
        MailApp.sendEmail({
          to: order.customer.email,
          subject: "We received your Malkah Hair order request",
          body: orderEmailBody_(order, false)
        });
        sheet.getRange(rowNumber, 5).setValue("sent");
        customerEmailSent = true;
      } catch (error) {
        console.error("Could not send the customer order confirmation.", error);
        sheet.getRange(rowNumber, 5).setValue("email failed");
      }
    }

    if (adminEmailSent && customerEmailSent) {
      sheet.getRange(rowNumber, 3).setValue("emails sent; unpaid");
      return { ok: true, duplicate: duplicate };
    }
    return {
      ok: false,
      saved: true,
      error: "The order was saved, but one or more emails could not be sent. Please retry or contact the store."
    };
  } finally {
    lock.releaseLock();
  }
}

function storeAndEmailContact_(contact) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_PROPERTY);
    if (!spreadsheetId) throw new Error("Run setupMalkahHair before accepting messages.");
    const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName("Contact messages");
    if (!sheet) throw new Error("Contact messages sheet is missing. Run setupMalkahHair again.");
    const lastRow = sheet.getLastRow();
    let rowNumber = 0;
    let adminEmailSent = false;
    let customerEmailSent = false;

    if (lastRow > 1) {
      const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
      for (let index = 0; index < ids.length; index += 1) {
        if (ids[index][0] === contact.id) {
          rowNumber = index + 2;
          const statuses = sheet.getRange(rowNumber, 3, 1, 2).getValues()[0];
          adminEmailSent = statuses[0] === "sent";
          customerEmailSent = statuses[1] === "sent";
          break;
        }
      }
    }

    if (!rowNumber) {
      checkSubmissionRate_(contact.email);
      rowNumber = lastRow + 1;
      sheet.getRange(rowNumber, 1, 1, CONTACT_HEADERS.length).setValues([[
        contact.id,
        contact.createdAt,
        "pending",
        "pending",
        safeCell_(contact.name),
        safeCell_(contact.email),
        safeCell_(contact.message)
      ]]);
      sheet.getRange(rowNumber, 2).setNumberFormat("yyyy-mm-dd hh:mm:ss");
    }

    upsertCustomer_({
      name: contact.name,
      email: contact.email
    }, { messageId: contact.id });

    if (!adminEmailSent) {
      try {
        MailApp.sendEmail({
          to: STORE_EMAIL,
          subject: "New Malkah Hair message from " + contact.name,
          body: "New contact message\n\nName: " + contact.name + "\nEmail: " + contact.email +
            "\n\nMessage:\n" + contact.message
        });
        sheet.getRange(rowNumber, 3).setValue("sent");
        adminEmailSent = true;
      } catch (error) {
        console.error("Could not send the store contact notification.", error);
        sheet.getRange(rowNumber, 3).setValue("email failed");
      }
    }

    if (!customerEmailSent) {
      try {
        MailApp.sendEmail({
          to: contact.email,
          subject: "We received your message — Malkah Hair",
          body: "Hi " + contact.name + ",\n\nThanks for contacting Malkah Hair. We received your message and will get back to you.\n\nYour message:\n" + contact.message
        });
        sheet.getRange(rowNumber, 4).setValue("sent");
        customerEmailSent = true;
      } catch (error) {
        console.error("Could not send the customer contact acknowledgment.", error);
        sheet.getRange(rowNumber, 4).setValue("email failed");
      }
    }

    if (adminEmailSent && customerEmailSent) return { ok: true };
    return {
      ok: false,
      saved: true,
      error: "The message was saved, but one or more emails could not be sent. Please retry or contact the store."
    };
  } finally {
    lock.releaseLock();
  }
}

function upsertCustomer_(customer, activity) {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_PROPERTY);
  if (!spreadsheetId) throw new Error("Run setupMalkahHair before accepting customers.");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  let sheet = spreadsheet.getSheetByName("Customers");
  if (!sheet) {
    sheet = spreadsheet.insertSheet("Customers");
    sheet.appendRow(CUSTOMER_HEADERS);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(CUSTOMER_HEADERS);
    sheet.setFrozenRows(1);
  }

  const email = customer.email.trim().toLowerCase();
  const lastRow = sheet.getLastRow();
  let rowNumber = 0;
  if (lastRow > 1) {
    const emails = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    for (let index = 0; index < emails.length; index += 1) {
      if (emails[index][0].trim().toLowerCase() === email) {
        rowNumber = index + 2;
        break;
      }
    }
  }

  const now = new Date();
  const existing = rowNumber
    ? sheet.getRange(rowNumber, 1, 1, CUSTOMER_HEADERS.length).getValues()[0]
    : [];
  const valueOrExisting = function (key, column) {
    const incoming = customer[key];
    return typeof incoming === "string" && incoming.trim()
      ? safeCell_(incoming.trim())
      : (existing[column] || "");
  };
  const row = [
    email,
    valueOrExisting("name", 1),
    valueOrExisting("phone", 2),
    valueOrExisting("city", 3),
    valueOrExisting("address", 4),
    valueOrExisting("postalCode", 5),
    existing[6] || activity.createdAt || now,
    activity.createdAt || now,
    activity.orderId || existing[8] || "",
    activity.messageId || existing[9] || ""
  ];
  if (!rowNumber) rowNumber = lastRow + 1;
  sheet.getRange(rowNumber, 1, 1, CUSTOMER_HEADERS.length).setValues([row]);
  sheet.getRange(rowNumber, 7, 1, 2).setNumberFormat("yyyy-mm-dd hh:mm:ss");
}

function migrateExistingCustomers_(spreadsheet) {
  const activities = [];
  const orders = spreadsheet.getSheetByName("Orders");
  if (orders && orders.getLastRow() > 1) {
    orders.getRange(2, 1, orders.getLastRow() - 1, ORDER_HEADERS.length).getValues()
      .forEach(function (row) {
        if (!row[6]) return;
        activities.push({
          createdAt: row[1] || new Date(),
          customer: {
            name: String(row[5] || ""),
            email: String(row[6]),
            phone: String(row[7] || ""),
            city: String(row[8] || ""),
            address: String(row[9] || ""),
            postalCode: String(row[10] || "")
          },
          activity: { orderId: String(row[0] || "") }
        });
      });
  }

  const contacts = spreadsheet.getSheetByName("Contact messages");
  if (contacts && contacts.getLastRow() > 1) {
    contacts.getRange(2, 1, contacts.getLastRow() - 1, CONTACT_HEADERS.length).getValues()
      .forEach(function (row) {
        if (!row[5]) return;
        activities.push({
          createdAt: row[1] || new Date(),
          customer: {
            name: String(row[4] || ""),
            email: String(row[5])
          },
          activity: { messageId: String(row[0] || "") }
        });
      });
  }

  activities.sort(function (left, right) {
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
  activities.forEach(function (entry) {
    upsertCustomer_(entry.customer, {
      orderId: entry.activity.orderId,
      messageId: entry.activity.messageId,
      createdAt: entry.createdAt
    });
  });
}

function checkSubmissionRate_(email) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    email.toLowerCase(),
    Utilities.Charset.UTF_8
  );
  const key = "malkah-submit-" + Utilities.base64EncodeWebSafe(digest).slice(0, 32);
  const cache = CacheService.getScriptCache();
  if (cache.get(key)) throw new Error("Please wait before sending another request.");
  cache.put(key, "1", 60);
}

function orderEmailBody_(order, isStoreNotification) {
  const itemLines = order.items.map(function (item) {
    return "- " + item.name + " x " + item.quantity + " — " + formatRand_(item.unitPrice * item.quantity);
  });
  const customerLines = [
    "Name: " + order.customer.name,
    "Email: " + order.customer.email,
    "Phone: " + order.customer.phone,
    "Town / city: " + order.customer.city,
    "Delivery address: " + order.customer.address,
    "Postal code: " + order.customer.postalCode
  ];
  const storeIntro = isStoreNotification
    ? "A new order request was submitted. Payment has NOT been taken."
    : "Thank you for your order request. We have received your details and will contact you to confirm delivery.";
  return [
    storeIntro,
    "",
    "Order reference: " + order.id,
    "",
    "Customer details:",
    customerLines.join("\n"),
    "",
    "Hair:",
    itemLines.join("\n"),
    "",
    "Hair subtotal: " + formatRand_(order.total),
    "Delivery fee: To be confirmed separately",
    "Payment status: Unpaid — this message is not a payment confirmation."
  ].join("\n");
}

function formatRand_(amount) {
  return "R" + Number(amount).toLocaleString("en-ZA");
}

function safeCell_(value) {
  const text = String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function response_(result, requestId) {
  const message = JSON.stringify({ ...result, requestId: requestId })
    .replace(/</g, "\\u003c");
  const html = "<!doctype html><html><body><script>" +
    "window.top.postMessage(" + message + ",'*');" +
    "</script></body></html>";
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
