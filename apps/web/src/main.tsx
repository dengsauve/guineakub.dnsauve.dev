import { createRoot } from "react-dom/client";
import "./style.css";
function App() {
  return (
    <main>
      <p>Family game night</p>
      <h1>Guineakub</h1>
      <p>A shared table, a private rack, and guinea pig jokers.</p>
      <p role="status">
        The table is being prepared. Game rules are awaiting family approval.
      </p>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App />);
