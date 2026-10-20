const requireAdmin = require("./adminAuth");
require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const app = express();
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://rabia-cell.github.io"
  ]
}));
app.use(express.json());
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5,
  idleTimeoutMillis: 300000,
  connectionTimeoutMillis: 10000
});
app.get("/", (req, res) => {
  res.send("Aura Perfumes Backend is Working!");
});
app.get("/api/products", async (req, res) => {
  try {
const startTime = performance.now();
const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.category,
        p.description,
        COALESCE(
          json_agg(
            json_build_object(
              'size', ps.size,
              'price', ps.price,
              'stock', ps.stock
            )
            ORDER BY ps.price
          ) FILTER (WHERE ps.id IS NOT NULL),
          '[]'
        ) AS sizes
      FROM public."Products" p
      LEFT JOIN public.products_size ps
        ON ps.product_id = p.id
      GROUP BY
        p.id,
        p.name,
        p.category,
        p.description
      ORDER BY p.id;
    `);
console.log(
  "Products database query:",
  (performance.now() - startTime).toFixed(2),
  "ms"
);
    res.json(result.rows);

  } catch (error) {
    console.error("Products error:", error);
    res.status(500).json({
      error: "Failed to load products"
    });
  }
});
app.post("/api/orders", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      first_name,
      last_name,
      email,
      phone,
      address,
      city,
      total,
      items
    } = req.body;

    const customerFields = [
      first_name,
      last_name,
      email,
      phone,
      address,
      city
    ]

    if (
      customerFields.some(
        (value) =>
          typeof value !== "string" ||
          value.trim() === ""
      )
    ) {
      return res.status(400).json({
        error: "Please fill in all customer details"
      })
    }
await client.query("BEGIN");
    if (!Array.isArray(items) || items.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Your cart is empty"
      });
    }
    let calculatedTotal = 0
    const verifiedItems = []
const seenProducts = new Set()
for (const item of items) {
const itemKey = `${item.product_id}-${item.size}`

if (seenProducts.has(itemKey)) {
  await client.query("ROLLBACK")
  return res.status(400).json({
    error: "Duplicate product size in order"
  })
}

seenProducts.add(itemKey)
      const requestedQuantity = Number(item.quantity)

      if (
        !Number.isInteger(requestedQuantity) ||
        requestedQuantity < 1
      ) {
        await client.query("ROLLBACK")
        return res.status(400).json({
          error: "Invalid product quantity"
        })
      }

      const productResult = await client.query(
        `SELECT price, stock
         FROM public.products_size
         WHERE product_id = $1 AND size = $2
         FOR UPDATE`,
        [item.product_id, item.size]
      )

      if (productResult.rows.length === 0) {
        await client.query("ROLLBACK")
        return res.status(400).json({
          error: "Product size not found"
        })
      }

      const productSize = productResult.rows[0]
      if (requestedQuantity > Number(productSize.stock)) {
        await client.query("ROLLBACK")
        return res.status(400).json({
          error: "Not enough stock available"
        })
      }

      // Calculate price using database values
      const actualPrice = Number(productSize.price)

      if (!Number.isFinite(actualPrice) || actualPrice < 0) {
        throw new Error("Invalid database product price")
      }

      calculatedTotal += actualPrice * requestedQuantity

      verifiedItems.push({
        ...item,
        price: actualPrice,
        quantity: requestedQuantity
      })
    }
    const orderResult = await client.query(
      `INSERT INTO public.orders
      (first_name, last_name, email, phone, address, city, total, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, created_at`,
      [
        first_name,
        last_name,
        email,
        phone,
        address,
        city,
        calculatedTotal,
        "Pending"
      ]
    );

    const orderId = orderResult.rows[0].id;
for (const item of verifiedItems) {    
      await client.query(
        `INSERT INTO public.order_items
        (order_id, product_id, product_name, size, price, quantity)
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          item.product_id,
          item.product_name,
          item.size,
          item.price,
          item.quantity
        ]
      );
    }
    for (const item of verifiedItems) {
      await client.query(
        `UPDATE public.products_size
         SET stock = stock - $1
         WHERE product_id = $2 AND size = $3`,
        [
          item.quantity,
          item.product_id,
          item.size
        ]
      )
    }
    await client.query("COMMIT");

    res.status(201).json({
      message: "Order placed successfully!",
      order_id: orderId
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Order error:", error);

    res.status(500).json({
      error: "Failed to place order"
    });

  } finally {
    client.release();
  }
});
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        o.*,
        COALESCE(
          json_agg(
            json_build_object(
              'product_id', oi.product_id,
              'product_name', oi.product_name,
              'size', oi.size,
              'price', oi.price,
              'quantity', oi.quantity
            )
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'
        ) AS items
      FROM public.orders o
      LEFT JOIN public.order_items oi
        ON oi.order_id = o.id
      GROUP BY o.id
      ORDER BY o.created_at DESC;
    `);

    res.json(result.rows);

  } catch (error) {
    console.error("Orders error:", error);

    res.status(500).json({
      error: "Failed to load orders"
    });
  }
});
app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = [
    "Pending",
    "Start Packing",
    "Packed",
    "Shipped",
    "Delivered",
    "Cancelled"
  ];

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({
      error: "Invalid order ID"
    });
  }

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: "Invalid order status"
    });
  }

  try {
    const result = await pool.query(
      `UPDATE public.orders
       SET status = $1
       WHERE id = $2
       RETURNING id, status`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Order not found"
      });
    }

    res.json({
      message: "Order status updated successfully",
      order: result.rows[0]
    });

  } catch (error) {
    console.error("Status update error:", error);

    res.status(500).json({
      error: "Failed to update order status"
    });
  }
});
const PORT = process.env.PORT || 3000;
// Admin: Update product stock
app.patch("/api/admin/products/stock", requireAdmin, async (req, res) => {
  const { product_id, size, stock } = req.body;

  if (
    !Number.isInteger(product_id) ||
    typeof size !== "string" ||
    !Number.isInteger(stock) ||
    stock < 0
  ) {
    return res.status(400).json({
      error: "Invalid product, size or stock"
    });
  }

  try {
    const result = await pool.query(
      `UPDATE public.products_size
       SET stock = $1
       WHERE product_id = $2 AND size = $3
       RETURNING product_id, size, stock`,
      [stock, product_id, size]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Product size not found"
      });
    }

    res.json({
      message: "Stock updated successfully",
      product: result.rows[0]
    });

  } catch (error) {
    console.error("Stock update error:", error);

    res.status(500).json({
      error: "Failed to update stock"
    });
  }
});
pool.query('SELECT 1')
  .then(() => console.log('Database connection ready'))
  .catch((error) => console.error('Database warm-up failed:', error.message));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
