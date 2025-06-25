// Importaciones necesarias
require('dotenv').config();
const axios = require('axios');
const fs = require('fs/promises'); // Para escribir en el archivo

// Configuración de la API desde .env
const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
const accessToken = process.env.SHOPIFY_ADMIN_API_TOKEN;
const graphqlUrl = `https://${shopifyDomain}/admin/api/2024-04/graphql.json`;

// La consulta GraphQL para obtener productos por etiqueta, manejando paginación.
// Pedimos solo los datos que nos interesan, INCLUYENDO IMÁGENES.
const getProductsQuery = `
  query getProductsByTag($cursor: String) {
    products(first: 50, after: $cursor, query: "tag:b2b") {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          tags
          totalInventory
          images(first: 5) {
            edges {
              node {
                id
                url
                altText
                width
                height
              }
            }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
                image {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchAllB2BProducts() {
  console.log('�� Iniciando sincronización masiva de productos B2B...');
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  try {
    // Usamos un bucle para recorrer todas las páginas de resultados
    while (hasNextPage) {
      const response = await axios.post(
        graphqlUrl,
        {
          query: getProductsQuery,
          variables: { cursor: cursor },
        },
        {
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        }
      );
      
      const productsData = response.data.data.products;
      const productsOnPage = productsData.edges.map(edge => edge.node);
      allProducts = allProducts.concat(productsOnPage);

      hasNextPage = productsData.pageInfo.hasNextPage;
      cursor = productsData.pageInfo.endCursor;
      
      console.log(`📄 Página procesada. Productos encontrados hasta ahora: ${allProducts.length}`);
    }

    // Guardamos los productos en un archivo JSON que actuará como nuestra base de datos temporal
    await fs.writeFile('b2b-products.json', JSON.stringify(allProducts, null, 2));
    
    console.log(`✅ ¡Sincronización completa! Se encontraron ${allProducts.length} productos B2B.`);
    console.log('Los datos se han guardado en b2b-products.json');

  } catch (error) {
    console.error('❌ Error durante la sincronización:');
    if (error.response) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
  }
}

// Ejecutar el script directamente
fetchAllB2BProducts();
