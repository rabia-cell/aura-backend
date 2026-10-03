require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
app.get("/", (req, res) => {
  res.send("Aura Perfumes Backend is Working!");
});
app.get("/api/products", async (req, res) => {
  try {
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

    await client.query("BEGIN");
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
        total,
        "Pending"
      ]
    );

    const orderId = orderResult.rows[0].id;
    for (const item of items) {
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
app.get("/api/orders", async (req, res) => {
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

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
