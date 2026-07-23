import { addDish, getDishes } from "./store.js";

const seedDishes = {
  carb_heavy: [
    "Whole Wheat Hakka Noodles",
    "Pesto Spaghetti",
    "Wheat Macaroni Pasta Red Sauce",
    "Wheat Macaroni Pasta White Sauce",
    "Tehri",
    "Chicken Pulao"
  ],
  chicken_main: ["Chicken Curry", "Chicken Chilli", "Tawa Chicken 65"],
  paneer_main: ["Palak Paneer", "Paneer Sauté", "Paneer Chilli"],
  sabzi: [
    "Mix Veg Paneer",
    "Aloo Gobi Capsicum Masala",
    "Egg Bhurji",
    "Egg Curry",
    "Dosa Chutney",
    "Cheela Chutney",
    "Sandwich"
  ],
  dry_chicken: ["Lemon Pepper Chicken", "Tandoori Chicken", "Cajun Chicken"]
};

const tags = {
  "Tandoori Chicken": ["needs_overnight_marination"],
  "Dosa Chutney": ["contains_masala_aloo"],
  Sandwich: ["contains_masala_aloo"]
};

export async function seedStore() {
  const existingNames = new Set(
    (await getDishes()).map((dish) => dish.name.toLowerCase())
  );
  for (const [category, names] of Object.entries(seedDishes)) {
    for (const name of names) {
      if (existingNames.has(name.toLowerCase())) continue;
      await addDish({ name, category, tags: tags[name] ?? [] });
    }
  }
}
